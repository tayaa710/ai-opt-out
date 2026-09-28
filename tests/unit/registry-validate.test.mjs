import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  emptyRegistry,
  isHttpsUrl,
  isValidDate,
  validateAutomation,
  validateRegistry,
  validateService,
} from '../../extension/lib/registry-validate.js';
import { ROOT } from './helpers/chrome-mock.mjs';
import { SCRIPT_URL, makeRegistry, makeService, toggleOptOut } from './helpers/fixtures.mjs';

const NOW = new Date('2026-09-28T12:00:00Z');

describe('validateRegistry', () => {
  test('accepts a valid registry and returns a sanitised copy', () => {
    const raw = makeRegistry();
    const r = validateRegistry(raw, { now: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.registry.services.length, 2);
    assert.deepEqual(r.registry.services, raw.services);
    assert.deepEqual(r.dropped, []);
  });

  test('rejects an unsupported formatVersion', () => {
    const r = validateRegistry({ ...makeRegistry(), formatVersion: 2 }, { now: NOW });
    assert.equal(r.ok, false);
    assert.match(r.error, /formatVersion/);
  });

  test('rejects missing/invalid generatedAt and far-future dates', () => {
    assert.equal(validateRegistry({ ...makeRegistry(), generatedAt: 'yesterday' }, { now: NOW }).ok, false);
    const future = validateRegistry({ ...makeRegistry(), generatedAt: '2027-01-01T00:00:00Z' }, { now: NOW });
    assert.equal(future.ok, false);
    assert.match(future.error, /future/);
    const slightSkew = validateRegistry(
      { ...makeRegistry(), generatedAt: '2026-09-29T00:00:00Z' },
      { now: NOW },
    );
    assert.equal(slightSkew.ok, true);
  });

  test('rejects non-objects and non-array services', () => {
    assert.equal(validateRegistry(null).ok, false);
    assert.equal(validateRegistry([]).ok, false);
    assert.equal(validateRegistry({ ...makeRegistry(), services: {} }, { now: NOW }).ok, false);
  });

  test('drops invalid and duplicate services but keeps the rest', () => {
    const good = makeService();
    const bad = makeService({ id: 'Bad Id' });
    const dup = makeService({ name: 'Duplicate' });
    const r = validateRegistry(makeRegistry([good, bad, dup, 'junk']), { now: NOW });
    assert.equal(r.ok, true);
    assert.deepEqual(
      r.registry.services.map((s) => s.name),
      ['ChatGPT'],
    );
    assert.equal(r.dropped.length, 3);
    assert.match(r.dropped[0].errors.join(), /id/);
    assert.match(r.dropped[1].errors.join(), /duplicate/);
  });

  test('cleans crawlers, dropping invalid ones and unknown fields', () => {
    const r = validateRegistry(
      {
        ...makeRegistry(),
        crawlers: [
          {
            token: 'GPTBot',
            operator: 'OpenAI',
            purpose: 'training',
            respectsRobotsTxt: true,
            docsUrl: 'https://x.test/',
          },
          { token: 'Evil', operator: 'X', docsUrl: SCRIPT_URL, extra: 1 },
          { operator: 'no token' },
        ],
      },
      { now: NOW },
    );
    assert.deepEqual(r.registry.crawlers, [
      {
        token: 'GPTBot',
        operator: 'OpenAI',
        purpose: 'training',
        respectsRobotsTxt: true,
        docsUrl: 'https://x.test/',
      },
      { token: 'Evil', operator: 'X' },
    ]);
  });

  test('emptyRegistry is valid in shape but has no services', () => {
    const e = emptyRegistry();
    assert.equal(e.formatVersion, 1);
    assert.deepEqual(e.services, []);
  });
});

describe('validateService', () => {
  test('rejects services whose links are not https (e.g. javascript: URLs)', () => {
    const s = makeService();
    s.optOuts[0].url = SCRIPT_URL;
    const r = validateService(s);
    assert.equal(r.service, null);
    assert.match(r.errors.join(), /optOuts\[0\]\.url/);
  });

  test('filters non-https sources/policy URLs and invalid contacts', () => {
    const s = makeService({
      sources: [
        { title: 'Good source', url: 'https://ok.test/' },
        { title: 'Bad source', url: 'http://insecure.test/' },
      ],
      policyUrls: ['https://ok.test/privacy', 'data:text/html,hi'],
      contacts: {
        privacyEmail: 'not-email',
        privacyRequestUrl: 'https://privacy.test/',
        dpoEmail: 'dpo@x.test',
      },
    });
    const r = validateService(s);
    assert.deepEqual(r.service.sources, [{ title: 'Good source', url: 'https://ok.test/' }]);
    assert.deepEqual(r.service.policyUrls, ['https://ok.test/privacy']);
    assert.deepEqual(r.service.contacts, {
      privacyRequestUrl: 'https://privacy.test/',
      dpoEmail: 'dpo@x.test',
    });
  });

  test('an invalid automation recipe is removed, the opt-out is kept for guided mode', () => {
    const s = makeService();
    s.optOuts[0].automation.steps.push({ action: 'eval', code: 'alert(1)' });
    const r = validateService(s);
    assert.ok(r.service);
    assert.equal(r.service.optOuts[0].automation, undefined);
    assert.equal(r.service.optOuts[0].url, 'https://chatgpt.com/#settings/DataControls');
    assert.match(r.warnings.join(), /automation removed/);
  });

  test('automation host patterns must be https://host/* patterns', () => {
    for (const bad of ['<all_urls>', 'http://chatgpt.com/*', 'https://chatgpt.com/settings', '*://*/*']) {
      const { automation } = validateAutomation({ ...toggleOptOut().automation, hostPermissions: [bad] });
      assert.equal(automation, null, bad);
    }
    const { automation } = validateAutomation({
      ...toggleOptOut().automation,
      hostPermissions: ['https://*.example.org/*', 'https://*.example.org/*'],
    });
    assert.deepEqual(automation.hostPermissions, ['https://*.example.org/*']);
  });

  test('step rules: target/state/ms requirements, bounds and nesting depth', () => {
    const base = toggleOptOut().automation;
    const bad = [
      [{ action: 'click' }],
      [{ action: 'setToggle', target: { role: 'switch' } }],
      [{ action: 'setToggle', target: { role: 'switch' }, state: 'maybe' }],
      [{ action: 'wait' }],
      [{ action: 'wait', ms: 99999 }],
      [{ action: 'waitFor', target: { role: 'switch' }, timeoutMs: -1 }],
      [{ action: 'click', target: { role: 'slider' } }],
      [{ action: 'click', target: {} }],
      [{ action: 'click', target: { text: ['x'] } }],
      [
        {
          action: 'click',
          target: { within: { within: { within: { within: { within: { role: 'dialog' } } } } } },
        },
      ],
      [],
    ];
    for (const steps of bad) {
      assert.equal(validateAutomation({ ...base, steps }).automation, null, JSON.stringify(steps));
    }
    const ok = validateAutomation({
      ...base,
      steps: [
        { action: 'wait', ms: 500 },
        {
          action: 'click',
          target: { role: 'button', text: ['Done'], within: { role: 'dialog' } },
          optional: true,
        },
      ],
    });
    assert.ok(ok.automation);
  });

  test('unknown category becomes "other"; unknown data types and regions are filtered', () => {
    const s = makeService({ category: 'metaverse' });
    s.training.dataTypes = ['chats', 'thoughts'];
    s.optOuts[0].regions = ['ALL', 'MARS'];
    const r = validateService(s);
    assert.equal(r.service.category, 'other');
    assert.deepEqual(r.service.training.dataTypes, ['chats']);
    assert.deepEqual(r.service.optOuts[0].regions, ['ALL']);
  });

  test('toggle/form opt-outs need a url; duplicate opt-out ids are rejected', () => {
    const s = makeService();
    delete s.optOuts[1].url;
    assert.equal(validateService(s).service, null);
    const d = makeService();
    d.optOuts[1].id = d.optOuts[0].id;
    assert.match(validateService(d).errors.join(), /duplicate/);
  });

  test('changelog/policyVersion/lastVerified are required and checked', () => {
    assert.equal(validateService(makeService({ policyVersion: 0 })).service, null);
    assert.equal(validateService(makeService({ lastVerified: '2026-02-30' })).service, null);
    assert.equal(validateService(makeService({ changelog: [{ version: 1 }] })).service, null);
  });

  test('invalid brandColor is dropped with a warning (UI uses it in styles)', () => {
    const r = validateService(makeService({ brandColor: 'red;background:url(x)' }));
    assert.equal(r.service.brandColor, undefined);
    assert.match(r.warnings.join(), /brandColor/);
  });

  test('unknown top-level fields are stripped', () => {
    const r = validateService({ ...makeService(), injected: '<script>' });
    assert.equal('injected' in r.service, false);
  });
});

describe('helpers', () => {
  test('isHttpsUrl', () => {
    assert.equal(isHttpsUrl('https://example.org/x'), true);
    assert.equal(isHttpsUrl('http://example.org/'), false);
    assert.equal(isHttpsUrl('https://user:pw@example.org/'), false);
    assert.equal(isHttpsUrl(SCRIPT_URL), false);
    assert.equal(isHttpsUrl('https://'), false);
    assert.equal(isHttpsUrl(42), false);
  });

  test('isValidDate rejects impossible dates', () => {
    assert.equal(isValidDate('2026-02-28'), true);
    assert.equal(isValidDate('2026-02-30'), false);
    assert.equal(isValidDate('2026-2-3'), false);
  });
});

describe('real registry entries', () => {
  const dir = path.join(ROOT, 'registry/services');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
  for (const file of files) {
    test(`${file} passes validation without losing data`, () => {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const r = validateService(raw);
      assert.deepEqual(r.errors, []);
      assert.deepEqual(r.service, raw);
    });
  }
});
