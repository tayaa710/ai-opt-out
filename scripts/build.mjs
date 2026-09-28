#!/usr/bin/env node
// Builds the store packages.
//
//   node scripts/build.mjs [--skip-registry]
//
// 1. Compiles the registry (scripts/build-registry.mjs), which also syncs the manifest's
//    optional_host_permissions and the bundled extension/data/registry.json.
// 2. Copies extension/ to dist/chrome/ and dist/firefox/ (dotfiles, tests, source maps and
//    Markdown are left out). The Firefox copy gets a transformed manifest.
// 3. Checks both packages: every file the manifest references exists, i18n keys resolve, store
//    length limits hold, and no page or module loads remote code.
// 4. Writes reproducible zips dist/notrain-{chrome,firefox}-<version>.zip and dist/SHA256SUMS.
//
// extension/manifest.json is the single source of truth for the version; package.json must match.

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zipSync } from 'fflate';
import { buildRegistry } from './build-registry.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const GECKO_ID = 'notrain@tayaa710.github.io';
export const GECKO_MIN_VERSION = '128.0';

/** Manifest keys that Firefox does not support (AMO's linter flags them). */
export const CHROME_ONLY_KEYS = Object.freeze([
  'minimum_chrome_version',
  'key',
  'update_url',
  'offline_enabled',
  'side_panel',
  'externally_connectable',
  'oauth2',
  'differential_fingerprint',
]);

/** API permissions that only exist in Chrome. */
export const CHROME_ONLY_PERMISSIONS = Object.freeze(['offscreen', 'sidePanel', 'tabGroups', 'favicon']);

/** Chrome Web Store / manifest limits. */
export const LIMITS = Object.freeze({ name: 75, shortName: 12, description: 132 });

/**
 * Fixed timestamp for every zip entry so that identical inputs give byte-identical zips.
 * fflate encodes DOS times from local-time fields, so build the date from local fields too.
 */
const ZIP_MTIME = new Date(1980, 0, 1, 0, 0, 0);

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Whether a path inside extension/ belongs in the package.
 * @param {string} rel POSIX-style path relative to the extension root
 */
export function shouldInclude(rel) {
  const parts = rel.split('/');
  if (parts.some((p) => p.startsWith('.'))) return false; // dotfiles and dot-directories
  if (parts.some((p) => ['test', 'tests', '__tests__', '__mocks__', 'node_modules'].includes(p)))
    return false;
  const base = parts[parts.length - 1];
  if (/\.(map|md|markdown)$/i.test(base)) return false;
  if (/\.(test|spec)\.[cm]?[jt]s$/i.test(base)) return false;
  if (/^(Thumbs\.db|desktop\.ini)$/i.test(base)) return false;
  if (/~$|\.(swp|swo|orig|rej|log)$/i.test(base)) return false;
  return true;
}

/** Chrome's version format: 1 to 4 dot-separated integers, each 0–65535, no leading zeros. */
export function isValidExtensionVersion(version) {
  if (typeof version !== 'string') return false;
  const parts = version.split('.');
  return (
    parts.length >= 1 &&
    parts.length <= 4 &&
    parts.every((p) => /^(0|[1-9]\d{0,4})$/.test(p) && Number(p) <= 65535)
  );
}

/**
 * Firefox flavour of a Chrome MV3 manifest. Returns a new object; key order is preserved.
 * @param {object} manifest Chrome manifest
 */
export function firefoxManifest(manifest) {
  const out = {};
  for (const [key, value] of Object.entries(manifest)) {
    if (CHROME_ONLY_KEYS.includes(key)) continue;
    if (key === 'background') {
      const script = value?.service_worker ?? value?.scripts?.[0];
      if (!script) throw new Error('manifest.background has no service_worker to convert');
      out.background = { scripts: [script], type: 'module' };
      continue;
    }
    if (key === 'permissions' || key === 'optional_permissions') {
      out[key] = value.filter((p) => !CHROME_ONLY_PERMISSIONS.includes(p));
      continue;
    }
    out[key] = structuredClone(value);
  }
  const existing = manifest.browser_specific_settings ?? {};
  out.browser_specific_settings = {
    ...existing,
    gecko: {
      ...(existing.gecko ?? {}),
      id: GECKO_ID,
      strict_min_version: GECKO_MIN_VERSION,
      // Firefox's built-in data consent (required for new AMO listings): NoTrain collects nothing.
      data_collection_permissions: { required: ['none'] },
    },
  };
  return out;
}

function msgKey(value) {
  const m = typeof value === 'string' ? /^__MSG_(\w+)__$/.exec(value) : null;
  return m ? m[1] : null;
}

/** Every file path the manifest references (relative to the package root). */
export function referencedFiles(manifest) {
  const refs = new Set();
  const add = (p) => {
    if (typeof p === 'string' && p && !p.includes('*')) refs.add(p.replace(/^\//, ''));
  };
  add(manifest.background?.service_worker);
  (manifest.background?.scripts ?? []).forEach(add);
  add(manifest.background?.page);
  add(manifest.action?.default_popup);
  add(manifest.options_ui?.page);
  add(manifest.options_page);
  add(manifest.devtools_page);
  add(manifest.side_panel?.default_path);
  const icons = (v) => (typeof v === 'string' ? add(v) : Object.values(v ?? {}).forEach(add));
  icons(manifest.icons);
  icons(manifest.action?.default_icon);
  for (const cs of manifest.content_scripts ?? []) {
    (cs.js ?? []).forEach(add);
    (cs.css ?? []).forEach(add);
  }
  for (const war of manifest.web_accessible_resources ?? []) (war.resources ?? []).forEach(add);
  if (manifest.default_locale) add(`_locales/${manifest.default_locale}/messages.json`);
  return [...refs].sort();
}

/**
 * Static checks on a package. `files` maps relative path → Buffer.
 * @returns {string[]} problems (empty when the package is fine)
 */
export function checkPackage(manifest, files, label = 'package') {
  const problems = [];
  const has = (p) => files.has(p);
  for (const ref of referencedFiles(manifest)) {
    if (!has(ref)) problems.push(`${label}: manifest references "${ref}", which is not in the package`);
  }

  // i18n: every __MSG_x__ in the manifest must exist in the default locale.
  let messages = {};
  if (manifest.default_locale) {
    const buf = files.get(`_locales/${manifest.default_locale}/messages.json`);
    if (buf) {
      try {
        messages = JSON.parse(buf.toString('utf8'));
      } catch (err) {
        problems.push(
          `${label}: _locales/${manifest.default_locale}/messages.json is not valid JSON: ${err.message}`,
        );
      }
    }
  }
  const resolve = (field) => {
    const value = manifest[field];
    const key = msgKey(value);
    if (!key) return value;
    const entry =
      messages[key] ?? messages[Object.keys(messages).find((k) => k.toLowerCase() === key.toLowerCase())];
    if (!entry?.message) {
      problems.push(
        `${label}: manifest.${field} uses __MSG_${key}__ but the default locale has no such message`,
      );
      return '';
    }
    return entry.message;
  };
  const name = resolve('name');
  const shortName = resolve('short_name');
  const description = resolve('description');
  if (name && name.length > LIMITS.name)
    problems.push(`${label}: name is ${name.length} characters (max ${LIMITS.name})`);
  if (shortName && shortName.length > LIMITS.shortName) {
    problems.push(`${label}: short_name is ${shortName.length} characters (max ${LIMITS.shortName})`);
  }
  if (description && description.length > LIMITS.description) {
    problems.push(`${label}: description is ${description.length} characters (max ${LIMITS.description})`);
  }
  if (!isValidExtensionVersion(manifest.version)) {
    problems.push(`${label}: version "${manifest.version}" is not a valid extension version`);
  }

  // No remote code (Chrome Web Store MV3 policy): no remote <script src>, no remote imports.
  for (const [rel, buf] of files) {
    if (/\.html?$/i.test(rel)) {
      const html = buf.toString('utf8');
      if (/<script\b[^>]*\bsrc\s*=\s*["']?\s*(https?:)?\/\//i.test(html)) {
        problems.push(`${label}: ${rel} loads a remote script`);
      }
    } else if (/\.m?js$/i.test(rel)) {
      const js = buf.toString('utf8');
      if (
        /\b(?:import|from)\s*\(?\s*["'](?:https?:)?\/\//.test(js) ||
        /importScripts\s*\(\s*["']https?:/.test(js)
      ) {
        problems.push(`${label}: ${rel} imports remote code`);
      }
    }
  }
  return problems;
}

/**
 * Build a reproducible zip: entries sorted, fixed timestamps.
 * @param {Map<string, Buffer|Uint8Array>} files
 * @returns {Uint8Array}
 */
export function createZip(files) {
  const entries = {};
  for (const rel of [...files.keys()].sort()) {
    entries[rel] = [new Uint8Array(files.get(rel)), { mtime: ZIP_MTIME }];
  }
  return zipSync(entries, { level: 9, mtime: ZIP_MTIME });
}

// ---------------------------------------------------------------------------
// File-system steps
// ---------------------------------------------------------------------------

/** Read all packageable files under `dir` into a Map (relative POSIX path → Buffer). */
export async function collectFiles(dir) {
  const files = new Map();
  async function walk(sub) {
    const entries = await readdir(path.join(dir, sub), { withFileTypes: true });
    for (const e of entries) {
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (!shouldInclude(rel)) continue;
      if (e.isDirectory()) await walk(rel);
      else if (e.isFile()) files.set(rel, await readFile(path.join(dir, rel)));
    }
  }
  await walk('');
  return new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

async function writeTree(outDir, files) {
  for (const [rel, buf] of files) {
    const target = path.join(outDir, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, buf);
  }
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * Run the whole build.
 * @param {object} [options]
 * @param {string} [options.root] repository root
 * @param {string} [options.outDir] output directory (default <root>/dist)
 * @param {boolean} [options.skipRegistry] do not run the registry build first
 * @param {(msg: string) => void} [options.log]
 * @returns {Promise<{ version: string, outputs: { chrome: string, firefox: string, sums: string }, files: number }>}
 */
export async function build({ root = ROOT, outDir, skipRegistry = false, log = () => {} } = {}) {
  const out = outDir ?? path.join(root, 'dist');
  const extDir = path.join(root, 'extension');

  if (!skipRegistry) {
    const reg = await buildRegistry({ root });
    if (reg.errors.length) {
      throw new Error(`Registry build failed:\n  ${reg.errors.join('\n  ')}`);
    }
    log(
      `Registry: ${reg.registry.services.length} services${reg.written.length ? ` (updated ${reg.written.join(', ')})` : ''}.`,
    );
  }

  const manifest = JSON.parse(await readFile(path.join(extDir, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const version = manifest.version;
  if (!isValidExtensionVersion(version)) {
    throw new Error(`extension/manifest.json version "${version}" is not a valid extension version`);
  }
  if (pkg.version !== version) {
    throw new Error(
      `Version mismatch: extension/manifest.json is ${version} but package.json is ${pkg.version}. ` +
        'The manifest is the source of truth; update package.json to match.',
    );
  }

  const files = await collectFiles(extDir);
  const chromeFiles = new Map(files);
  const ffManifest = firefoxManifest(manifest);
  const firefoxFiles = new Map(files);
  firefoxFiles.set('manifest.json', Buffer.from(`${JSON.stringify(ffManifest, null, 2)}\n`));

  const problems = [
    ...checkPackage(manifest, chromeFiles, 'chrome'),
    ...checkPackage(ffManifest, firefoxFiles, 'firefox'),
  ];
  if (problems.length) throw new Error(`Package checks failed:\n  ${problems.join('\n  ')}`);

  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await writeTree(path.join(out, 'chrome'), chromeFiles);
  await writeTree(path.join(out, 'firefox'), firefoxFiles);

  const chromeZip = path.join(out, `notrain-chrome-${version}.zip`);
  const firefoxZip = path.join(out, `notrain-firefox-${version}.zip`);
  const chromeBytes = createZip(chromeFiles);
  const firefoxBytes = createZip(firefoxFiles);
  await writeFile(chromeZip, chromeBytes);
  await writeFile(firefoxZip, firefoxBytes);
  const sums = path.join(out, 'SHA256SUMS');
  await writeFile(
    sums,
    `${sha256(chromeBytes)}  ${path.basename(chromeZip)}\n${sha256(firefoxBytes)}  ${path.basename(firefoxZip)}\n`,
  );

  log(`Packaged ${files.size} files, version ${version}:`);
  for (const [file, bytes] of [
    [chromeZip, chromeBytes],
    [firefoxZip, firefoxBytes],
  ]) {
    log(`  ${path.relative(root, file)}  ${(bytes.length / 1024).toFixed(1)} KiB`);
  }
  return { version, outputs: { chrome: chromeZip, firefox: firefoxZip, sums }, files: files.size };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  build({ skipRegistry: process.argv.includes('--skip-registry'), log: (m) => console.log(m) }).catch(
    (err) => {
      console.error(`Build failed: ${err.message}`);
      process.exit(1);
    },
  );
}
