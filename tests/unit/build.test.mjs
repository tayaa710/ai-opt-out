import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import {
  GECKO_ID,
  GECKO_MIN_VERSION,
  build,
  checkPackage,
  collectFiles,
  createZip,
  firefoxManifest,
  isValidExtensionVersion,
  referencedFiles,
  shouldInclude,
} from '../../scripts/build.mjs';

const chromeManifest = Object.freeze({
  manifest_version: 3,
  name: '__MSG_extName__',
  short_name: 'NoTrain',
  description: '__MSG_extDescription__',
  version: '1.2.3',
  default_locale: 'en',
  minimum_chrome_version: '116',
  icons: { 128: 'icons/icon-128.png' },
  background: { service_worker: 'background/service-worker.js', type: 'module' },
  action: { default_popup: 'popup/popup.html', default_icon: { 16: 'icons/icon-16.png' } },
  options_ui: { page: 'dashboard/dashboard.html', open_in_tab: true },
  permissions: ['storage', 'scripting', 'offscreen'],
  optional_permissions: ['cookies'],
  optional_host_permissions: ['https://chatgpt.com/*'],
});

const messages = JSON.stringify({
  extName: { message: 'NoTrain: Opt out of AI training' },
  extDescription: { message: 'See which services train AI on your data.' },
});

function filesFor(manifest, extra = {}) {
  return new Map(
    Object.entries({
      'manifest.json': JSON.stringify(manifest),
      '_locales/en/messages.json': messages,
      'background/service-worker.js': 'import "./x.js";',
      'popup/popup.html': '<script type="module" src="popup.js"></script>',
      'dashboard/dashboard.html': '<p>hi</p>',
      'icons/icon-128.png': 'png',
      'icons/icon-16.png': 'png',
      ...extra,
    }).map(([k, v]) => [k, Buffer.from(v)]),
  );
}

describe('shouldInclude', () => {
  test('keeps extension files', () => {
    for (const p of [
      'manifest.json',
      'lib/letters.js',
      'icons/icon-128.png',
      '_locales/en/messages.json',
      'data/registry.json',
    ]) {
      assert.ok(shouldInclude(p), p);
    }
  });
  test('drops dotfiles, tests, source maps, docs and editor junk', () => {
    for (const p of [
      '.DS_Store',
      'lib/.eslintrc.json',
      '.git/config',
      'lib/letters.js.map',
      'lib/letters.test.js',
      'content/engine.spec.mjs',
      'tests/fixture.html',
      'lib/__tests__/a.js',
      'README.md',
      'Thumbs.db',
      'lib/file.js~',
      'lib/file.swp',
    ]) {
      assert.ok(!shouldInclude(p), p);
    }
  });
});

describe('isValidExtensionVersion', () => {
  test('accepts Chrome versions and rejects others', () => {
    for (const v of ['1', '1.0', '1.0.0', '1.2.3.4', '65535.0']) assert.ok(isValidExtensionVersion(v), v);
    for (const v of ['', '1.0.0.0.0', '01.0', '1.0-beta', '65536', 'v1', 1])
      assert.ok(!isValidExtensionVersion(v), String(v));
  });
});

describe('firefoxManifest', () => {
  test('converts the service worker to a module background script and adds gecko settings', () => {
    const ff = firefoxManifest(chromeManifest);
    assert.deepEqual(ff.background, { scripts: ['background/service-worker.js'], type: 'module' });
    assert.equal(ff.browser_specific_settings.gecko.id, GECKO_ID);
    assert.equal(ff.browser_specific_settings.gecko.strict_min_version, GECKO_MIN_VERSION);
    assert.equal(GECKO_ID, 'notrain@tayaa710.github.io');
    assert.equal(GECKO_MIN_VERSION, '128.0');
    assert.deepEqual(ff.browser_specific_settings.gecko.data_collection_permissions, { required: ['none'] });
  });

  test('drops Chrome-only keys and permissions but keeps everything else', () => {
    const ff = firefoxManifest(chromeManifest);
    assert.ok(!('minimum_chrome_version' in ff));
    assert.deepEqual(ff.permissions, ['storage', 'scripting']);
    assert.deepEqual(ff.optional_host_permissions, ['https://chatgpt.com/*']);
    assert.deepEqual(ff.optional_permissions, ['cookies']);
    assert.deepEqual(ff.options_ui, chromeManifest.options_ui);
    assert.deepEqual(Object.keys(ff).slice(0, 3), ['manifest_version', 'name', 'short_name']);
  });

  test('does not mutate its input', () => {
    const copy = structuredClone(chromeManifest);
    firefoxManifest(copy);
    assert.deepEqual(copy, structuredClone(chromeManifest));
  });

  test('requires a background script', () => {
    assert.throws(() => firefoxManifest({ ...chromeManifest, background: {} }), /no service_worker/);
  });
});

describe('referencedFiles and checkPackage', () => {
  test('lists the files the manifest needs', () => {
    assert.deepEqual(referencedFiles(chromeManifest), [
      '_locales/en/messages.json',
      'background/service-worker.js',
      'dashboard/dashboard.html',
      'icons/icon-128.png',
      'icons/icon-16.png',
      'popup/popup.html',
    ]);
  });

  test('a complete package passes', () => {
    assert.deepEqual(checkPackage(chromeManifest, filesFor(chromeManifest)), []);
    const ff = firefoxManifest(chromeManifest);
    assert.deepEqual(checkPackage(ff, filesFor(ff)), []);
  });

  test('reports missing files, missing messages, store limits and remote code', () => {
    const files = filesFor(chromeManifest, {
      '_locales/en/messages.json': JSON.stringify({ extName: { message: 'x'.repeat(80) } }),
      'lib/bad.js': "import x from 'https://cdn.example.com/x.js';",
      'popup/popup.html': '<script src="https://cdn.example.com/lib.js"></script>',
    });
    files.delete('icons/icon-16.png');
    const problems = checkPackage(chromeManifest, files, 'chrome').join('\n');
    assert.match(problems, /references "icons\/icon-16\.png"/);
    assert.match(problems, /__MSG_extDescription__ but the default locale has no such message/);
    assert.match(problems, /name is 80 characters \(max 75\)/);
    assert.match(problems, /lib\/bad\.js imports remote code/);
    assert.match(problems, /popup\/popup\.html loads a remote script/);
  });
});

describe('createZip', () => {
  test('round-trips and is byte-for-byte reproducible', () => {
    const files = filesFor(chromeManifest);
    const a = createZip(files);
    const b = createZip(new Map([...files.entries()].reverse()));
    assert.deepEqual(Buffer.from(a), Buffer.from(b));
    const unzipped = unzipSync(a);
    assert.deepEqual(Object.keys(unzipped), [...files.keys()].sort());
    assert.equal(Buffer.from(unzipped['manifest.json']).toString(), JSON.stringify(chromeManifest));
  });
});

describe('build (end to end in a temp dir)', () => {
  let root;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'notrain-build-'));
    for (const [rel, buf] of filesFor(chromeManifest, {
      '.hidden': 'secret',
      'lib/app.js.map': '{}',
      'NOTES.md': '# notes',
      'tests/x.test.js': 'test',
    })) {
      await mkdir(path.dirname(path.join(root, 'extension', rel)), { recursive: true });
      await writeFile(path.join(root, 'extension', rel), buf);
    }
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'notrain', version: '1.2.3' }));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('writes chrome and firefox folders, zips and checksums', async () => {
    const res = await build({ root, skipRegistry: true });
    assert.equal(res.version, '1.2.3');
    const dist = path.join(root, 'dist');
    const chromeZip = unzipSync(await readFile(path.join(dist, 'notrain-chrome-1.2.3.zip')));
    const firefoxZip = unzipSync(await readFile(path.join(dist, 'notrain-firefox-1.2.3.zip')));
    for (const zip of [chromeZip, firefoxZip]) {
      assert.ok(zip['manifest.json'], 'manifest.json at the zip root');
      for (const excluded of ['.hidden', 'lib/app.js.map', 'NOTES.md', 'tests/x.test.js']) {
        assert.ok(!zip[excluded], `${excluded} excluded`);
      }
    }
    const ff = JSON.parse(Buffer.from(firefoxZip['manifest.json']).toString());
    assert.deepEqual(ff.background.scripts, ['background/service-worker.js']);
    assert.ok(!('minimum_chrome_version' in ff));
    const chrome = JSON.parse(Buffer.from(chromeZip['manifest.json']).toString());
    assert.equal(chrome.background.service_worker, 'background/service-worker.js');
    assert.ok((await stat(path.join(dist, 'chrome', 'popup', 'popup.html'))).isFile());
    assert.equal(
      JSON.parse(await readFile(path.join(dist, 'firefox', 'manifest.json'), 'utf8'))
        .browser_specific_settings.gecko.id,
      GECKO_ID,
    );
    const sums = await readFile(path.join(dist, 'SHA256SUMS'), 'utf8');
    assert.match(
      sums,
      /^[0-9a-f]{64} {2}notrain-chrome-1\.2\.3\.zip\n[0-9a-f]{64} {2}notrain-firefox-1\.2\.3\.zip\n$/,
    );
  });

  test('builds are reproducible', async () => {
    await build({ root, skipRegistry: true });
    const first = await readFile(path.join(root, 'dist', 'SHA256SUMS'), 'utf8');
    await build({ root, skipRegistry: true });
    assert.equal(await readFile(path.join(root, 'dist', 'SHA256SUMS'), 'utf8'), first);
  });

  test('fails when package.json and the manifest disagree on the version', async () => {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    await assert.rejects(
      build({ root, skipRegistry: true }),
      /Version mismatch: extension\/manifest\.json is 1\.2\.3 but package\.json is 9\.9\.9/,
    );
  });

  test('fails when the manifest references a missing file', async () => {
    await rm(path.join(root, 'extension', 'dashboard', 'dashboard.html'));
    await assert.rejects(build({ root, skipRegistry: true }), /references "dashboard\/dashboard\.html"/);
  });

  test('collectFiles skips excluded paths', async () => {
    const files = await collectFiles(path.join(root, 'extension'));
    assert.ok(files.has('manifest.json'));
    assert.ok(!files.has('.hidden'));
    assert.ok(!files.has('NOTES.md'));
  });
});

describe('repository metadata', () => {
  test('package.json and extension/manifest.json versions match', async () => {
    const root = path.resolve(import.meta.dirname, '../..');
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const manifest = JSON.parse(await readFile(path.join(root, 'extension', 'manifest.json'), 'utf8'));
    assert.equal(pkg.version, manifest.version);
    assert.ok(isValidExtensionVersion(manifest.version));
  });
});
