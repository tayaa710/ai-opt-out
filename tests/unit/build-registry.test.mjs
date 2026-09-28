import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ROOT,
  buildRegistry,
  canonicalize,
  checkServiceInvariants,
  cookieOriginPattern,
  hostMatchesPattern,
  isValidDate,
  latestToday,
  readablePath,
  requiredHostPermissions,
  setOptionalHostPermissions,
} from '../../scripts/build-registry.mjs';
import { END_MARKER, START_MARKER, renderServicesTable } from '../../scripts/readme-services.mjs';

const NOW = new Date('2026-09-28T12:00:00Z');

function makeService(id, name, overrides = {}) {
  return {
    id,
    name,
    company: `${name} Inc.`,
    category: 'ai-assistant',
    domains: [`${id}.example.com`],
    summary: `${name} trains on your chats unless you turn it off in settings.`,
    training: {
      trainsOnUserData: 'yes',
      defaultState: 'opted_in',
      dataTypes: ['chats'],
      details: 'Conversations are used for training unless you opt out.',
      retroactiveRemoval: false,
    },
    optOuts: [
      {
        id: 'toggle',
        type: 'toggle',
        title: 'Turn off training',
        url: `https://${id}.example.com/settings`,
        regions: ['ALL'],
        effort: 'quick',
        steps: ['Open settings and switch it off.'],
        effect: 'Stops future training on your chats.',
        automation: {
          confidence: 'medium',
          hostPermissions: [`https://${id}.example.com/*`],
          steps: [{ action: 'setToggle', target: { role: 'switch', text: ['Training'] }, state: 'off' }],
          verify: [{ action: 'assertToggle', target: { role: 'switch', text: ['Training'] }, state: 'off' }],
        },
      },
    ],
    detection: { cookies: [{ url: `https://login.${id}.example.com`, name: 'session' }] },
    policyUrls: [`https://${id}.example.com/privacy`],
    sources: [{ title: 'Help article', url: `https://${id}.example.com/help`, accessed: '2026-09-01' }],
    lastVerified: '2026-09-01',
    policyVersion: 1,
    changelog: [{ version: 1, date: '2026-09-01', summary: 'Added to the registry.', severity: 'info' }],
    ...overrides,
  };
}

const MANIFEST = `{
  "manifest_version": 3,
  "name": "NoTrain",
  "version": "1.0.0",
  "permissions": ["storage"],
  "optional_permissions": ["cookies"],
  "optional_host_permissions": ["https://old.example.com/*"],
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'"
  }
}
`;

const CRAWLERS = {
  crawlers: [
    {
      token: 'GPTBot',
      operator: 'OpenAI',
      purpose: 'training',
      respectsRobotsTxt: true,
      docsUrl: 'https://openai.com/bots',
    },
    {
      token: 'CCBot',
      operator: 'Common Crawl',
      purpose: 'training',
      respectsRobotsTxt: true,
      docsUrl: 'https://commoncrawl.org/ccbot',
    },
  ],
};

let root;

async function writeJson(rel, data) {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`);
}

async function read(rel) {
  return readFile(path.join(root, rel), 'utf8');
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'notrain-registry-'));
  await mkdir(path.join(root, 'registry/schema'), { recursive: true });
  for (const f of ['service.schema.json', 'crawlers.schema.json']) {
    await copyFile(path.join(ROOT, 'registry/schema', f), path.join(root, 'registry/schema', f));
  }
  await writeJson('registry/services/zeta.json', makeService('zeta', 'Zeta'));
  await writeJson('registry/services/alpha.json', makeService('alpha', 'alpha chat'));
  await writeJson('registry/crawlers.json', CRAWLERS);
  await writeJson('extension/manifest.json', MANIFEST);
  await writeJson('README.md', `# Test\n\n${START_MARKER}\nold table\n${END_MARKER}\n\nFooter.\n`);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('buildRegistry: good registry', () => {
  test('compiles identical outputs, sorted by name, with crawlers', async () => {
    const res = await buildRegistry({ root, now: NOW });
    assert.deepEqual(res.errors, []);
    assert.equal(res.ok, true);
    const outputs = ['registry/dist/registry.json', 'extension/data/registry.json', 'site/registry.json'];
    const texts = await Promise.all(outputs.map(read));
    assert.equal(texts[0], texts[1]);
    assert.equal(texts[0], texts[2]);
    const reg = JSON.parse(texts[0]);
    assert.equal(reg.formatVersion, 1);
    assert.equal(reg.generatedAt, NOW.toISOString());
    assert.deepEqual(Object.keys(reg), ['formatVersion', 'generatedAt', 'services', 'crawlers']);
    assert.deepEqual(
      reg.services.map((s) => s.id),
      ['alpha', 'zeta'],
    );
    assert.deepEqual(
      reg.crawlers.map((c) => c.token),
      ['CCBot', 'GPTBot'],
    );
    for (const rel of outputs) assert.ok(res.written.includes(rel));
  });

  test('normalises key order to the schema order', async () => {
    const svc = makeService('alpha', 'alpha chat');
    const shuffled = Object.fromEntries(Object.entries(svc).reverse());
    await writeJson('registry/services/alpha.json', shuffled);
    await buildRegistry({ root, now: NOW });
    const reg = JSON.parse(await read('registry/dist/registry.json'));
    const keys = Object.keys(reg.services[0]);
    assert.deepEqual(keys.slice(0, 4), ['id', 'name', 'company', 'category']);
    assert.deepEqual(Object.keys(reg.services[0].optOuts[0]).slice(0, 3), ['id', 'type', 'title']);
  });

  test('rewrites only optional_host_permissions in the manifest', async () => {
    const res = await buildRegistry({ root, now: NOW });
    const text = await read('extension/manifest.json');
    const manifest = JSON.parse(text);
    assert.deepEqual(manifest.optional_host_permissions, [
      'https://alpha.example.com/*',
      'https://login.alpha.example.com/*',
      'https://login.zeta.example.com/*',
      'https://zeta.example.com/*',
    ]);
    assert.deepEqual(res.hostPermissions, manifest.optional_host_permissions);
    // Everything else is byte-for-byte unchanged.
    const strip = (t) => t.replace(/ {2}"optional_host_permissions": \[[^\]]*\],\n/, '');
    assert.equal(strip(text), strip(MANIFEST));
    assert.match(text, /"optional_host_permissions": \[\n {4}"https:\/\/alpha\.example\.com\/\*",\n/);
  });

  test('updates the README services table between the markers', async () => {
    await buildRegistry({ root, now: NOW });
    const readme = await read('README.md');
    assert.ok(readme.startsWith('# Test\n\n'));
    assert.ok(readme.endsWith(`${END_MARKER}\n\nFooter.\n`));
    assert.match(readme, /\[alpha chat\]\(registry\/services\/alpha\.json\)/);
    assert.match(readme, /2 services, 2 with one-click automation/);
    assert.doesNotMatch(readme, /old table/);
  });

  test('rebuilding unchanged content is a no-op and keeps generatedAt', async () => {
    await buildRegistry({ root, now: NOW });
    const first = await read('registry/dist/registry.json');
    const res = await buildRegistry({ root, now: new Date('2027-01-01T00:00:00Z') });
    assert.deepEqual(res.written, []);
    assert.equal(await read('registry/dist/registry.json'), first);
  });

  test('a content change produces a new generatedAt', async () => {
    await buildRegistry({ root, now: NOW });
    await writeJson(
      'registry/services/zeta.json',
      makeService('zeta', 'Zeta', { summary: 'Zeta changed its policy and now trains on everything.' }),
    );
    const later = new Date('2026-09-29T08:00:00Z');
    await buildRegistry({ root, now: later });
    const reg = JSON.parse(await read('registry/dist/registry.json'));
    assert.equal(reg.generatedAt, later.toISOString());
  });

  test('--check passes when up to date and reports stale outputs without writing', async () => {
    await buildRegistry({ root, now: NOW });
    assert.equal((await buildRegistry({ root, check: true, now: NOW })).ok, true);

    await writeJson('registry/services/zeta.json', makeService('zeta', 'Zeta Two'));
    await writeJson('extension/manifest.json', MANIFEST);
    const before = await read('registry/dist/registry.json');
    const res = await buildRegistry({ root, check: true, now: NOW });
    assert.equal(res.ok, false);
    assert.deepEqual(res.errors, []);
    assert.ok(res.outdated.some((o) => o.startsWith('registry/dist/registry.json')));
    assert.ok(res.outdated.some((o) => /optional_host_permissions: missing https:\/\/alpha/.test(o)));
    assert.ok(res.outdated.some((o) => o.startsWith('README.md')));
    assert.deepEqual(res.written, []);
    assert.equal(await read('registry/dist/registry.json'), before);
    assert.equal(await read('extension/manifest.json'), MANIFEST);
  });

  test('a missing crawlers.json is a warning, not an error', async () => {
    await rm(path.join(root, 'registry/crawlers.json'));
    const res = await buildRegistry({ root, now: NOW });
    assert.deepEqual(res.errors, []);
    assert.ok(res.warnings.some((w) => w.includes('registry/crawlers.json')));
    assert.deepEqual(res.registry.crawlers, []);
  });
});

describe('buildRegistry: errors name the file and JSON path', () => {
  const cases = [
    [
      'schema violation (unknown property)',
      () => writeJson('registry/services/alpha.json', { ...makeService('alpha', 'Alpha'), bogus: true }),
      /registry\/services\/alpha\.json → bogus: unknown property/,
    ],
    [
      'schema violation (enum) with allowed values',
      () =>
        writeJson('registry/services/alpha.json', {
          ...makeService('alpha', 'Alpha'),
          category: 'games',
        }),
      /alpha\.json → category: must be one of: "ai-assistant"/,
    ],
    [
      'toggle without url',
      () => {
        const s = makeService('alpha', 'Alpha');
        delete s.optOuts[0].url;
        delete s.optOuts[0].automation;
        return writeJson('registry/services/alpha.json', s);
      },
      /alpha\.json → optOuts\[0\]\.url: is required but missing/,
    ],
    [
      'id does not match the file name',
      () => writeJson('registry/services/alpha.json', makeService('alpha-two', 'Alpha')),
      /alpha\.json → id: "alpha-two" must equal the file name/,
    ],
    [
      'duplicate opt-out id',
      () => {
        const s = makeService('alpha', 'Alpha');
        s.optOuts.push({ ...s.optOuts[0], automation: undefined });
        delete s.optOuts[1].automation;
        return writeJson('registry/services/alpha.json', s);
      },
      /alpha\.json → optOuts\[1\]\.id: "toggle" is used by more than one opt-out/,
    ],
    [
      'no changelog entry for policyVersion',
      () => writeJson('registry/services/alpha.json', makeService('alpha', 'Alpha', { policyVersion: 2 })),
      /alpha\.json → changelog: no entry has version 2/,
    ],
    [
      'lastVerified in the future',
      () =>
        writeJson(
          'registry/services/alpha.json',
          makeService('alpha', 'Alpha', { lastVerified: '2026-12-01' }),
        ),
      /alpha\.json → lastVerified: "2026-12-01" is in the future/,
    ],
    [
      'impossible date',
      () =>
        writeJson(
          'registry/services/alpha.json',
          makeService('alpha', 'Alpha', { lastVerified: '2026-02-30' }),
        ),
      /lastVerified: "2026-02-30" is not a real calendar date/,
    ],
    [
      'verify step that changes a setting',
      () => {
        const s = makeService('alpha', 'Alpha');
        s.optOuts[0].automation.verify = [{ action: 'setToggle', target: { role: 'switch' }, state: 'off' }];
        return writeJson('registry/services/alpha.json', s);
      },
      /optOuts\[0\]\.automation\.verify\[0\]\.action: verify steps must be read-only/,
    ],
    [
      'invalid JSON',
      () => writeJson('registry/services/alpha.json', '{ "id": "alpha", }'),
      /registry\/services\/alpha\.json: invalid JSON/,
    ],
    [
      'duplicate crawler token',
      () =>
        writeJson('registry/crawlers.json', {
          crawlers: [...CRAWLERS.crawlers, { ...CRAWLERS.crawlers[0], token: 'gptbot' }],
        }),
      /registry\/crawlers\.json → crawlers\[2\]\.token: "gptbot" duplicates crawlers\[0\]/,
    ],
    [
      'crawler schema violation',
      () =>
        writeJson('registry/crawlers.json', { crawlers: [{ ...CRAWLERS.crawlers[0], purpose: 'spying' }] }),
      /registry\/crawlers\.json → crawlers\[0\]\.purpose: must be one of/,
    ],
  ];
  for (const [name, setup, pattern] of cases) {
    test(name, async () => {
      await setup();
      const res = await buildRegistry({ root, now: NOW });
      assert.equal(res.ok, false);
      assert.ok(
        res.errors.some((e) => pattern.test(e)),
        `expected an error matching ${pattern}, got:\n${res.errors.join('\n')}`,
      );
      assert.deepEqual(res.written, [], 'nothing is written when validation fails');
    });
  }

  test('duplicate ids across files', async () => {
    await writeJson('registry/services/zeta.json', makeService('alpha', 'Zeta'));
    const res = await buildRegistry({ root, now: NOW });
    assert.ok(res.errors.some((e) => /zeta\.json → id: "alpha" must equal the file name/.test(e)));
  });
});

describe('buildRegistry: warnings', () => {
  test('warns about automation hosts that do not match the opt-out URL, stale entries and missing policy URLs', async () => {
    const s = makeService('alpha', 'Alpha', { lastVerified: '2025-01-01', policyUrls: [] });
    s.optOuts[0].automation.hostPermissions = ['https://other.example.com/*'];
    s.sources[0].accessed = '2025-01-01';
    s.changelog[0].date = '2025-01-01';
    await writeJson('registry/services/alpha.json', s);
    const res = await buildRegistry({ root, now: NOW });
    assert.deepEqual(res.errors, []);
    assert.ok(res.warnings.some((w) => /none of https:\/\/other\.example\.com\/\* matches the host/.test(w)));
    assert.ok(res.warnings.some((w) => /lastVerified: 2025-01-01 is \d+ days old/.test(w)));
    assert.ok(res.warnings.some((w) => /policyUrls: empty or missing/.test(w)));
  });
});

describe('helpers', () => {
  test('readablePath', () => {
    assert.equal(readablePath(''), '(root)');
    assert.equal(readablePath('/optOuts/1/automation/steps/0'), 'optOuts[1].automation.steps[0]');
    assert.equal(readablePath('/training/regionNotes/US-CA'), 'training.regionNotes["US-CA"]');
  });

  test('hostMatchesPattern and cookieOriginPattern', () => {
    assert.ok(hostMatchesPattern('chatgpt.com', 'https://chatgpt.com/*'));
    assert.ok(hostMatchesPattern('www.pinterest.com', 'https://*.pinterest.com/*'));
    assert.ok(hostMatchesPattern('pinterest.com', 'https://*.pinterest.com/*'));
    assert.ok(!hostMatchesPattern('evilpinterest.com', 'https://*.pinterest.com/*'));
    assert.ok(!hostMatchesPattern('chatgpt.com', 'http://chatgpt.com/*'));
    assert.equal(cookieOriginPattern('https://chatgpt.com'), 'https://chatgpt.com/*');
    assert.equal(cookieOriginPattern('https://www.x.com/path'), 'https://www.x.com/*');
  });

  test('requiredHostPermissions is a sorted, de-duplicated union', () => {
    const a = makeService('a', 'A');
    const b = makeService('b', 'B', {
      detection: { cookies: [{ url: 'https://a.example.com', name: 'x' }] },
    });
    assert.deepEqual(requiredHostPermissions([b, a]), [
      'https://a.example.com/*',
      'https://b.example.com/*',
      'https://login.a.example.com/*',
    ]);
  });

  test('setOptionalHostPermissions prints like Prettier', () => {
    const one = setOptionalHostPermissions(MANIFEST, ['https://a.com/*']);
    assert.match(one, /^ {2}"optional_host_permissions": \["https:\/\/a\.com\/\*"\],$/m);
    const many = Array.from({ length: 6 }, (_, i) => `https://host-number-${i}.example.com/*`);
    const multi = setOptionalHostPermissions(MANIFEST, many);
    assert.match(
      multi,
      /"optional_host_permissions": \[\n {4}"https:\/\/host-number-0\.example\.com\/\*",\n/,
    );
    assert.match(multi, /"https:\/\/host-number-5\.example\.com\/\*"\n {2}\],\n/);
    assert.deepEqual(JSON.parse(multi).optional_host_permissions, many);
    const none = setOptionalHostPermissions(MANIFEST, []);
    assert.match(none, /"optional_host_permissions": \[\],/);
  });

  test('setOptionalHostPermissions inserts the key when it is missing', () => {
    const without = MANIFEST.replace(/ {2}"optional_host_permissions": \[[^\]]*\],\n/, '');
    const out = setOptionalHostPermissions(without, ['https://a.com/*']);
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.optional_host_permissions, ['https://a.com/*']);
    assert.deepEqual(parsed.optional_permissions, ['cookies']);
  });

  test('canonicalize follows schema property order and resolves $ref', () => {
    const schema = {
      type: 'object',
      properties: { b: { type: 'string' }, a: { $ref: '#/$defs/inner' } },
      $defs: { inner: { type: 'object', properties: { y: {}, x: {} } } },
    };
    const out = canonicalize({ z: 1, a: { x: 1, y: 2 }, b: 'b' }, schema);
    assert.deepEqual(Object.keys(out), ['b', 'a', 'z']);
    assert.deepEqual(Object.keys(out.a), ['y', 'x']);
  });

  test('dates', () => {
    assert.ok(isValidDate('2024-02-29'));
    assert.ok(!isValidDate('2025-02-29'));
    assert.ok(!isValidDate('2026-9-1'));
    assert.equal(latestToday(new Date('2026-09-28T23:00:00Z')), '2026-09-29');
    assert.equal(latestToday(new Date('2026-09-28T01:00:00Z')), '2026-09-28');
  });

  test('checkServiceInvariants flags automation on email opt-outs', () => {
    const s = makeService('a', 'A');
    s.optOuts[0].type = 'email';
    const { warnings } = checkServiceInvariants(s, { file: 'a.json', fileId: 'a', today: '2026-09-28' });
    assert.ok(warnings.some((w) => /automation on an opt-out of type "email"/.test(w)));
  });

  test('renderServicesTable escapes pipes and marks automation', () => {
    const table = renderServicesTable([makeService('a', 'A | B')]);
    assert.match(table, /\[A \\\| B\]\(registry\/services\/a\.json\)/);
    assert.match(table, /Yes \(medium\)/);
  });
});
