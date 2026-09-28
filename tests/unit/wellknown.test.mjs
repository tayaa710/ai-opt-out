import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers/chrome-mock.mjs';
import { SCRIPT_URL } from './helpers/fixtures.mjs';
import {
  WELL_KNOWN_MAX_BYTES,
  WELL_KNOWN_PATH,
  fetchWellKnownInPage,
  probeWellKnown,
  registrableDomain,
  sameSite,
  validateWellKnown,
} from '../../extension/lib/wellknown.js';

const DOC = {
  version: 1,
  name: 'Example Service',
  trains_on_user_content: 'yes',
  default: 'opted_in',
  opt_out_url: 'https://example.com/settings/privacy/ai',
  policy_url: 'https://example.com/privacy#ai-training',
  data_types: ['posts', 'messages'],
  regions: ['ALL'],
  last_updated: '2026-09-01',
  contact: 'privacy@example.com',
};

describe('registrableDomain / sameSite', () => {
  test('handles common multi-label suffixes and hosting platforms', () => {
    assert.equal(registrableDomain('www.example.com'), 'example.com');
    assert.equal(registrableDomain('a.b.example.co.uk'), 'example.co.uk');
    assert.equal(registrableDomain('example.com.'), 'example.com');
    assert.equal(registrableDomain('alice.github.io'), 'alice.github.io');
    assert.equal(registrableDomain('localhost'), 'localhost');
    assert.equal(registrableDomain('192.168.0.1'), '192.168.0.1');
    assert.equal(sameSite('settings.example.com', 'www.example.com'), true);
    assert.equal(sameSite('alice.github.io', 'bob.github.io'), false);
    assert.equal(sameSite('example.co.uk', 'other.co.uk'), false);
  });
});

describe('validateWellKnown', () => {
  test('accepts the spec example and keeps only known fields', () => {
    const r = validateWellKnown({ ...DOC, unknown_field: 'ignored' }, 'www.example.com');
    assert.equal(r.ok, true);
    assert.deepEqual(r.document, DOC);
  });

  test('required fields', () => {
    const cases = [
      [{ ...DOC, version: 2 }, /version/],
      [{ ...DOC, version: '1' }, /version/],
      [{ ...DOC, trains_on_user_content: 'maybe' }, /trains_on_user_content/],
      [{ ...DOC, last_updated: '01/09/2026' }, /last_updated/],
      [{ ...DOC, opt_out_url: undefined }, /required/],
    ];
    for (const [doc, re] of cases) {
      const r = validateWellKnown(doc, 'example.com');
      assert.equal(r.ok, false);
      assert.match(r.errors.join(), re);
    }
    assert.equal(validateWellKnown([], 'example.com').ok, false);
    assert.equal(validateWellKnown(null, 'example.com').ok, false);
  });

  test('opt_out_url must be https and on the same registrable domain', () => {
    for (const url of [
      'http://example.com/x',
      'https://evil.test/x',
      SCRIPT_URL,
      'https://example.com.evil.test/',
    ]) {
      const r = validateWellKnown({ ...DOC, opt_out_url: url }, 'www.example.com');
      assert.equal(r.ok, false, url);
      assert.match(r.errors.join(), /opt_out_url/);
    }
    const sub = validateWellKnown(
      { ...DOC, opt_out_url: 'https://account.example.com/ai' },
      'www.example.com',
    );
    assert.equal(sub.ok, true);
  });

  test('"no" does not need an opt_out_url, and an offsite one is dropped', () => {
    const r = validateWellKnown(
      { ...DOC, trains_on_user_content: 'no', opt_out_url: 'https://evil.test/' },
      'example.com',
    );
    assert.equal(r.ok, true);
    assert.equal(r.document.opt_out_url, undefined);
  });

  test('invalid optional fields are dropped', () => {
    const r = validateWellKnown(
      {
        ...DOC,
        name: 42,
        default: 'whatever',
        policy_url: 'http://example.com/',
        data_types: ['ok', 7, 'x'.repeat(80)],
        regions: ['EU', 'MARS'],
        contact: 'not a contact',
      },
      'example.com',
    );
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(r.document).sort(), [
      'data_types',
      'last_updated',
      'opt_out_url',
      'regions',
      'trains_on_user_content',
      'version',
    ]);
    assert.deepEqual(r.document.data_types, ['ok']);
    assert.deepEqual(r.document.regions, ['EU']);
  });

  test('contact may be an https URL', () => {
    const r = validateWellKnown({ ...DOC, contact: 'https://example.com/contact' }, 'example.com');
    assert.equal(r.document.contact, 'https://example.com/contact');
  });
});

describe('probeWellKnown', () => {
  let mock;
  afterEach(() => mock?.uninstall());

  async function withTab(url) {
    mock = installChromeMock({ autoCompleteTabs: false });
    const tab = await mock.tabs.create({ url });
    mock.completeTab(tab.id, url);
    return tab.id;
  }

  test('returns the validated document found on the page origin', async () => {
    const tabId = await withTab('https://www.example.com/feed');
    mock.scripting.executeImpl = async () => [
      { frameId: 0, result: { origin: 'https://www.example.com', text: JSON.stringify(DOC) } },
    ];
    const r = await probeWellKnown({ tabId });
    assert.deepEqual(r, { found: true, url: `https://www.example.com${WELL_KNOWN_PATH}`, document: DOC });
    const call = mock.scripting.calls[0];
    assert.equal(call.func, 'fetchWellKnownInPage');
    assert.deepEqual(call.args, [WELL_KNOWN_PATH, WELL_KNOWN_MAX_BYTES, 3000]);
    assert.deepEqual(call.target, { tabId, frameIds: [0] });
  });

  test('restricted and non-https pages are not probed', async () => {
    for (const url of ['chrome://settings/', 'http://example.com/', 'file:///etc/passwd']) {
      const tabId = await withTab(url);
      const r = await probeWellKnown({ tabId });
      assert.deepEqual(r, { found: false, url: null, error: 'unsupported_page' });
      assert.equal(mock.scripting.calls.length, 0);
      mock.uninstall();
    }
  });

  test('graceful when the tab is gone, the URL is hidden or scripting is refused', async () => {
    mock = installChromeMock();
    assert.equal((await probeWellKnown({ tabId: 999 })).error, 'tab_not_found');
    mock.uninstall();

    const hidden = await withTab('https://example.com/');
    mock.tabsMap.get(hidden).url = undefined;
    assert.equal((await probeWellKnown({ tabId: hidden })).error, 'no_access');
    mock.uninstall();

    const tabId = await withTab('https://example.com/');
    mock.scripting.executeImpl = async () => {
      throw new Error('Cannot access contents of url. Extension manifest must request permission');
    };
    const r = await probeWellKnown({ tabId });
    assert.deepEqual(r, { found: false, url: `https://example.com${WELL_KNOWN_PATH}`, error: 'no_access' });
  });

  test('page-side errors, bad JSON and invalid documents are reported as not found', async () => {
    const tabId = await withTab('https://example.com/');
    const answer = (result) => {
      mock.scripting.executeImpl = async () => [{ frameId: 0, result }];
    };
    answer({ origin: 'https://example.com', error: 'not_found' });
    assert.equal((await probeWellKnown({ tabId })).error, 'not_found');
    answer({ origin: 'https://example.com', text: '<html>soft 404</html>' });
    assert.equal((await probeWellKnown({ tabId })).error, 'invalid_json');
    answer({
      origin: 'https://example.com',
      text: JSON.stringify({ ...DOC, opt_out_url: 'https://evil.test/' }),
    });
    const invalid = await probeWellKnown({ tabId });
    assert.equal(invalid.error, 'invalid_document');
    assert.equal(invalid.found, false);
    assert.match(invalid.problems.join(), /opt_out_url/);
    answer(null);
    assert.equal((await probeWellKnown({ tabId })).error, 'no_access');
  });

  test('uses the origin reported by the page if the tab navigated meanwhile', async () => {
    const tabId = await withTab('https://example.com/');
    mock.scripting.executeImpl = async () => [
      {
        frameId: 0,
        result: {
          origin: 'https://other.org',
          text: JSON.stringify({ ...DOC, opt_out_url: 'https://other.org/ai' }),
        },
      },
    ];
    const r = await probeWellKnown({ tabId });
    assert.equal(r.found, true);
    assert.equal(r.url, `https://other.org${WELL_KNOWN_PATH}`);
    mock.scripting.executeImpl = async () => [
      { frameId: 0, result: { origin: 'http://insecure.org', text: '{}' } },
    ];
    assert.equal((await probeWellKnown({ tabId })).error, 'unsupported_page');
  });
});

describe('fetchWellKnownInPage (runs in the page)', () => {
  const saved = { fetch: globalThis.fetch, location: globalThis.location };
  afterEach(() => {
    globalThis.fetch = saved.fetch;
    globalThis.location = saved.location;
  });
  const respond = (body, init = {}, url = `https://example.com${WELL_KNOWN_PATH}`) => {
    globalThis.fetch = async (path, opts) => {
      respond.last = { path, opts };
      const res = new Response(body, init);
      Object.defineProperty(res, 'url', { value: url });
      return res;
    };
  };

  test('same-origin GET without credentials, returns the text', async () => {
    globalThis.location = new URL('https://example.com/page');
    respond(JSON.stringify(DOC), { status: 200 });
    const r = await fetchWellKnownInPage(WELL_KNOWN_PATH, 1024, 1000);
    assert.equal(r.origin, 'https://example.com');
    assert.deepEqual(JSON.parse(r.text), DOC);
    assert.equal(respond.last.path, WELL_KNOWN_PATH);
    assert.equal(respond.last.opts.credentials, 'omit');
  });

  test('404, HTTP errors, offsite redirects and oversize bodies', async () => {
    globalThis.location = new URL('https://example.com/page');
    respond('nope', { status: 404 });
    assert.equal((await fetchWellKnownInPage(WELL_KNOWN_PATH, 1024, 1000)).error, 'not_found');
    respond('err', { status: 500 });
    assert.equal((await fetchWellKnownInPage(WELL_KNOWN_PATH, 1024, 1000)).error, 'http_500');
    respond('{}', { status: 200 }, 'https://evil.test/x');
    assert.equal((await fetchWellKnownInPage(WELL_KNOWN_PATH, 1024, 1000)).error, 'redirected_offsite');
    respond('x'.repeat(2048), { status: 200 });
    assert.equal((await fetchWellKnownInPage(WELL_KNOWN_PATH, 1024, 1000)).error, 'too_large');
    respond('x', { status: 200, headers: { 'content-length': '999999' } });
    assert.equal((await fetchWellKnownInPage(WELL_KNOWN_PATH, 1024, 1000)).error, 'too_large');
  });

  test('times out and reports network errors', async () => {
    globalThis.location = new URL('https://example.com/page');
    globalThis.fetch = (_p, opts) =>
      new Promise((_resolve, reject) =>
        opts.signal.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    assert.equal((await fetchWellKnownInPage(WELL_KNOWN_PATH, 1024, 10)).error, 'timeout');
    globalThis.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    assert.equal((await fetchWellKnownInPage(WELL_KNOWN_PATH, 1024, 1000)).error, 'network_error');
  });
});
