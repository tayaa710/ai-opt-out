import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  allowedHostPatterns,
  detectionOrigins,
  hasPermissions,
  isDeclared,
  manifestHostPatterns,
  originPattern,
  parseMatchPattern,
  patternCovers,
  urlMatchesAny,
  urlMatchesPattern,
} from '../../extension/lib/permissions.js';
import { installChromeMock } from './helpers/chrome-mock.mjs';
import {
  TEST_MANIFEST,
  exampleService,
  makeService,
  rogueService,
  toggleOptOut,
} from './helpers/fixtures.mjs';

const DECLARED = TEST_MANIFEST.optional_host_permissions;

describe('match patterns', () => {
  test('parseMatchPattern', () => {
    assert.deepEqual(parseMatchPattern('https://*.example.org/*'), {
      scheme: 'https',
      host: '*.example.org',
      path: '/*',
    });
    assert.deepEqual(parseMatchPattern('<all_urls>'), { scheme: '*', host: '*', path: '/*' });
    assert.equal(parseMatchPattern('https://example.org'), null);
    assert.equal(parseMatchPattern('ftp://example.org/*'), null);
    assert.equal(parseMatchPattern(42), null);
  });

  test('urlMatchesPattern', () => {
    assert.equal(urlMatchesPattern('https://chatgpt.com/#settings', 'https://chatgpt.com/*'), true);
    assert.equal(urlMatchesPattern('https://evil.chatgpt.com.test/', 'https://chatgpt.com/*'), false);
    assert.equal(urlMatchesPattern('http://chatgpt.com/', 'https://chatgpt.com/*'), false);
    assert.equal(urlMatchesPattern('https://a.b.example.org/x', 'https://*.example.org/*'), true);
    assert.equal(urlMatchesPattern('https://example.org/x', 'https://*.example.org/*'), true);
    assert.equal(urlMatchesPattern('https://notexample.org/x', 'https://*.example.org/*'), false);
    assert.equal(
      urlMatchesPattern('https://example.org/settings/ai?x=1', 'https://example.org/settings/*'),
      true,
    );
    assert.equal(urlMatchesPattern('https://example.org/other', 'https://example.org/settings/*'), false);
    assert.equal(urlMatchesPattern('https://user:pw@chatgpt.com/', 'https://chatgpt.com/*'), false);
    assert.equal(urlMatchesPattern('not a url', 'https://chatgpt.com/*'), false);
    assert.equal(urlMatchesAny('https://chatgpt.com/', ['https://x.test/*', 'https://chatgpt.com/*']), true);
    assert.equal(urlMatchesAny('https://chatgpt.com/', undefined), false);
  });

  test('patternCovers', () => {
    assert.equal(patternCovers('https://*.example.org/*', 'https://app.example.org/*'), true);
    assert.equal(patternCovers('https://*.example.org/*', 'https://*.app.example.org/*'), true);
    assert.equal(patternCovers('https://app.example.org/*', 'https://*.example.org/*'), false);
    assert.equal(patternCovers('https://chatgpt.com/*', 'https://chatgpt.com/*'), true);
    assert.equal(patternCovers('https://chatgpt.com/*', 'https://evil.test/*'), false);
    assert.equal(patternCovers('*://*/*', 'https://evil.test/*'), true);
    assert.equal(patternCovers('https://*/*', 'http://evil.test/*'), false);
    assert.equal(patternCovers('https://x.test/a/*', 'https://x.test/*'), false);
  });
});

describe('manifest intersection (remote registry cannot widen access)', () => {
  test('allowedHostPatterns keeps only declared patterns', () => {
    const opt = toggleOptOut({
      automation: {
        ...toggleOptOut().automation,
        hostPermissions: [
          'https://chatgpt.com/*',
          'https://evil.test/*',
          'https://app.example.org/*',
          '<all_urls>',
        ],
      },
    });
    assert.deepEqual(allowedHostPatterns(opt, DECLARED), [
      'https://chatgpt.com/*',
      'https://app.example.org/*',
    ]);
    assert.deepEqual(allowedHostPatterns(rogueService().optOuts[0], DECLARED), []);
    assert.deepEqual(allowedHostPatterns({ id: 'x' }, DECLARED), []);
  });

  test('manifestHostPatterns reads optional/host permissions (Chrome and Firefox layouts)', () => {
    assert.deepEqual(
      manifestHostPatterns({
        optional_host_permissions: ['https://a.test/*'],
        host_permissions: ['https://b.test/*'],
        optional_permissions: ['cookies', 'https://c.test/*'],
      }),
      ['https://a.test/*', 'https://b.test/*', 'https://c.test/*'],
    );
    assert.deepEqual(manifestHostPatterns(undefined), []);
  });

  test('isDeclared / originPattern / detectionOrigins', () => {
    assert.equal(isDeclared('https://www.example.org/*', DECLARED), true);
    assert.equal(isDeclared('https://evil.test/*', DECLARED), false);
    assert.equal(originPattern('https://chatgpt.com/some/path'), 'https://chatgpt.com/*');
    assert.equal(originPattern('http://chatgpt.com'), null);
    assert.equal(originPattern('nope'), null);
    assert.deepEqual(detectionOrigins([makeService(), exampleService(), rogueService()], DECLARED), [
      'https://app.example.org/*',
      'https://chatgpt.com/*',
    ]);
  });
});

describe('hasPermissions', () => {
  let mock;
  afterEach(() => mock?.uninstall());

  test('asks chrome.permissions.contains and treats empty requests as not granted', async () => {
    mock = installChromeMock({ manifest: TEST_MANIFEST, grantedOrigins: ['https://chatgpt.com/*'] });
    assert.equal(await hasPermissions({ origins: ['https://chatgpt.com/*'] }), true);
    assert.equal(await hasPermissions({ origins: ['https://app.example.org/*'] }), false);
    assert.equal(await hasPermissions({}), false);
    mock.permissions.contains = async () => {
      throw new Error('boom');
    };
    assert.equal(await hasPermissions({ origins: ['https://chatgpt.com/*'] }), false);
  });

  test('manifestHostPatterns defaults to the runtime manifest', () => {
    mock = installChromeMock({ manifest: TEST_MANIFEST });
    assert.deepEqual(manifestHostPatterns(), DECLARED);
  });
});
