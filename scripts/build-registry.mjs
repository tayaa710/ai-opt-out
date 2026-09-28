#!/usr/bin/env node
// Validates the NoTrain registry and compiles it.
//
//   node scripts/build-registry.mjs            validate, then write all outputs
//   node scripts/build-registry.mjs --check    validate only; exit 1 if any output is stale
//   node scripts/build-registry.mjs --strict   also fail on warnings
//
// Inputs:  registry/services/*.json (service.schema.json), registry/crawlers.json (crawlers.schema.json)
// Outputs: registry/dist/registry.json, extension/data/registry.json (identical), site/registry.json,
//          extension/manifest.json `optional_host_permissions`, README.md services table.
//
// Build-time invariants (see ARCHITECTURE.md "Registry") are enforced here so that CI fails on
// violations. Every error names the file and the JSON path it refers to.

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { updateReadmeServices } from './readme-services.mjs';
import { SEARCH_ENGINE_TOKENS as SEARCH_ENGINE_TOKEN_LIST } from '../extension/lib/robots.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FORMAT_VERSION = 1;

/** Paths, relative to the repository root. */
export const PATHS = Object.freeze({
  serviceSchema: 'registry/schema/service.schema.json',
  crawlersSchema: 'registry/schema/crawlers.schema.json',
  services: 'registry/services',
  crawlers: 'registry/crawlers.json',
  manifest: 'extension/manifest.json',
  outputs: ['registry/dist/registry.json', 'extension/data/registry.json', 'site/registry.json'],
});

/** Days after which `lastVerified` produces a staleness warning. */
export const STALE_AFTER_DAYS = 180;

/** Regular search-engine crawlers (shared with the creator tool, which never blocks them by default). */
export const SEARCH_ENGINE_TOKENS = new Set(SEARCH_ENGINE_TOKEN_LIST.map((t) => t.toLowerCase()));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** JSON pointer (Ajv instancePath) → readable path like `optOuts[1].automation.steps[0]`. */
export function readablePath(pointer) {
  if (!pointer) return '(root)';
  return pointer
    .split('/')
    .slice(1)
    .map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((acc, seg) => {
      if (/^\d+$/.test(seg)) return `${acc}[${seg}]`;
      if (/^[A-Za-z_$][\w$]*$/.test(seg)) return acc ? `${acc}.${seg}` : seg;
      return `${acc}[${JSON.stringify(seg)}]`;
    }, '');
}

/** Format Ajv errors as `file → path: message` lines, dropping noise from if/then wrappers. */
export function formatAjvErrors(file, errors) {
  const out = new Set();
  for (const e of errors ?? []) {
    if (e.keyword === 'if') continue;
    let where = e.instancePath;
    let message = e.message ?? 'is invalid';
    switch (e.keyword) {
      case 'additionalProperties':
        where = `${e.instancePath}/${e.params.additionalProperty}`;
        message = `unknown property (not allowed by the schema; check the spelling)`;
        break;
      case 'required':
        where = `${e.instancePath}/${e.params.missingProperty}`;
        message = 'is required but missing';
        break;
      case 'enum':
        message = `must be one of: ${e.params.allowedValues.map((v) => JSON.stringify(v)).join(', ')}`;
        break;
      case 'const':
        message = `must be ${JSON.stringify(e.params.allowedValue)}`;
        break;
      case 'pattern':
        message = `must match the pattern ${e.params.pattern}`;
        break;
      case 'format':
        message = `must be a valid ${e.params.format}`;
        break;
      case 'minProperties':
        message = 'must not be empty';
        break;
      default:
        break;
    }
    out.add(`${file} → ${readablePath(where)}: ${message}`);
  }
  return [...out];
}

/** True for a real calendar date in YYYY-MM-DD form. */
export function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * The latest calendar date that is "today" anywhere on Earth (UTC+14). Dates after it are in the
 * future for every contributor, whatever their time zone.
 */
export function latestToday(now = new Date()) {
  return new Date(now.getTime() + 14 * 3600 * 1000).toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/** Convert a Chrome match pattern like `https://*.example.com/*` into a host matcher. */
export function hostMatchesPattern(host, pattern) {
  const m = /^https:\/\/([^/]+)\/\*$/.exec(pattern);
  if (!m) return false;
  const p = m[1];
  if (p === '*') return true;
  if (p.startsWith('*.')) {
    const base = p.slice(2);
    return host === base || host.endsWith(`.${base}`);
  }
  return host === p;
}

/** `https://host/*` match pattern for a detection cookie URL. */
export function cookieOriginPattern(url) {
  const u = new URL(url);
  return `https://${u.hostname}/*`;
}

function resolveRef(schema, root) {
  let s = schema;
  const seen = new Set();
  while (s && typeof s.$ref === 'string' && s.$ref.startsWith('#/') && !seen.has(s.$ref)) {
    seen.add(s.$ref);
    s = s.$ref
      .slice(2)
      .split('/')
      .reduce((node, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], root);
  }
  return s ?? {};
}

/**
 * Return a deep copy of `value` whose object keys follow the order in which the JSON Schema
 * declares them (then any other keys alphabetically). Makes the compiled output independent of
 * how contributors order keys in source files.
 */
export function canonicalize(value, schema, rootSchema = schema) {
  const s = resolveRef(schema ?? {}, rootSchema);
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item, s.items ?? {}, rootSchema));
  }
  if (value && typeof value === 'object') {
    const declared = Object.keys(s.properties ?? {});
    const keys = [
      ...declared.filter((k) => Object.hasOwn(value, k)),
      ...Object.keys(value)
        .filter((k) => !declared.includes(k))
        .sort(),
    ];
    const out = {};
    for (const k of keys) {
      let child = s.properties?.[k];
      if (!child && s.patternProperties) {
        const hit = Object.entries(s.patternProperties).find(([re]) => new RegExp(re, 'u').test(k));
        child = hit?.[1];
      }
      out[k] = canonicalize(value[k], child ?? {}, rootSchema);
    }
    return out;
  }
  return value;
}

const compareText = (a, b) => {
  const x = String(a).toLowerCase();
  const y = String(b).toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
};

export function sortServices(services) {
  return [...services].sort((a, b) => compareText(a.name, b.name) || compareText(a.id, b.id));
}

export function sortCrawlers(crawlers) {
  return [...crawlers].sort((a, b) => compareText(a.operator, b.operator) || compareText(a.token, b.token));
}

export function serializeRegistry(registry) {
  return `${JSON.stringify(registry, null, 2)}\n`;
}

async function readJson(file, rel, errors) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    errors.push(`${rel}: cannot read file (${err.code ?? err.message})`);
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    errors.push(`${rel}: invalid JSON: ${err.message}`);
    return undefined;
  }
}

async function readTextIfExists(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

function createAjv() {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictTypes: false,
    strictRequired: false, // if/then blocks require properties declared on the parent
    allowUnionTypes: true,
  });
  addFormats(ajv);
  return ajv;
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

/**
 * Semantic checks beyond the JSON Schema for one (schema-valid) service.
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function checkServiceInvariants(service, { file, fileId, today }) {
  const errors = [];
  const warnings = [];
  const at = (p) => `${file} → ${p}`;

  if (service.id !== fileId) {
    errors.push(at(`id: "${service.id}" must equal the file name ("${fileId}.json")`));
  }

  // Dates.
  const dateFields = [['lastVerified', service.lastVerified]];
  (service.changelog ?? []).forEach((c, i) => dateFields.push([`changelog[${i}].date`, c.date]));
  (service.sources ?? []).forEach((src, i) => {
    if (src.accessed) dateFields.push([`sources[${i}].accessed`, src.accessed]);
  });
  for (const [where, value] of dateFields) {
    if (!isValidDate(value)) errors.push(at(`${where}: "${value}" is not a real calendar date`));
    else if (value > today) errors.push(at(`${where}: "${value}" is in the future`));
  }
  if (service.training?.since) {
    const [, month, day] = service.training.since.split('-');
    const bad =
      (month && (Number(month) < 1 || Number(month) > 12)) || (day && !isValidDate(service.training.since));
    if (bad) errors.push(at(`training.since: "${service.training.since}" is not a valid date`));
  }
  if (isValidDate(service.lastVerified) && service.lastVerified <= today) {
    const age = daysBetween(service.lastVerified, today);
    if (age > STALE_AFTER_DAYS) {
      warnings.push(
        at(`lastVerified: ${service.lastVerified} is ${age} days old; please re-verify the entry`),
      );
    }
  }

  // Changelog and policy version.
  const versions = (service.changelog ?? []).map((c) => c.version);
  if (!versions.includes(service.policyVersion)) {
    errors.push(
      at(
        `changelog: no entry has version ${service.policyVersion} (policyVersion). Add one describing the change`,
      ),
    );
  }
  const seenVersions = new Set();
  (service.changelog ?? []).forEach((c, i) => {
    if (seenVersions.has(c.version)) errors.push(at(`changelog[${i}].version: ${c.version} is duplicated`));
    seenVersions.add(c.version);
    if (c.version > service.policyVersion) {
      errors.push(
        at(`changelog[${i}].version: ${c.version} is greater than policyVersion ${service.policyVersion}`),
      );
    }
  });

  // Opt-outs.
  const optOutIds = new Set();
  const optOuts = service.optOuts ?? [];
  optOuts.forEach((o, i) => {
    const p = `optOuts[${i}]`;
    if (optOutIds.has(o.id)) errors.push(at(`${p}.id: "${o.id}" is used by more than one opt-out`));
    optOutIds.add(o.id);

    const a = o.automation;
    if (!a) return;
    if (!o.url) {
      errors.push(at(`${p}.automation: requires ${p}.url (the page the automation runs on)`));
    } else {
      let host;
      try {
        host = new URL(o.url).hostname;
      } catch {
        errors.push(at(`${p}.url: "${o.url}" is not a valid URL`));
      }
      if (host && !a.hostPermissions.some((pat) => hostMatchesPattern(host, pat))) {
        warnings.push(
          at(
            `${p}.automation.hostPermissions: none of ${a.hostPermissions.join(', ')} matches the host of ${p}.url (${host}); automation will not be injected unless the page redirects to a listed host`,
          ),
        );
      }
    }
    (a.verify ?? []).forEach((step, j) => {
      if (step.action === 'setToggle') {
        errors.push(
          at(
            `${p}.automation.verify[${j}].action: verify steps must be read-only; use "assertToggle" instead of "setToggle"`,
          ),
        );
      }
    });
    if (o.type === 'none' || o.type === 'email') {
      warnings.push(at(`${p}.automation: automation on an opt-out of type "${o.type}" is never run`));
    }
  });
  if (optOuts.length > 1 && optOuts.some((o) => o.type === 'none')) {
    warnings.push(
      at('optOuts: an opt-out of type "none" should be the only entry (it means no opt-out exists)'),
    );
  }
  if (
    optOuts.some((o) => o.type === 'email') &&
    !service.contacts?.privacyEmail &&
    !service.contacts?.dpoEmail
  ) {
    warnings.push(
      at('contacts: an opt-out of type "email" exists but contacts has no privacyEmail or dpoEmail'),
    );
  }

  // Detection cookies.
  (service.detection?.cookies ?? []).forEach((c, i) => {
    try {
      const u = new URL(c.url);
      if (u.pathname !== '/' || u.search || u.hash) {
        warnings.push(
          at(`detection.cookies[${i}].url: "${c.url}" should be an origin (https://host) without a path`),
        );
      }
    } catch {
      errors.push(at(`detection.cookies[${i}].url: "${c.url}" is not a valid URL`));
    }
  });

  if (!service.policyUrls?.length) {
    warnings.push(
      at('policyUrls: empty or missing, so scripts/policy-watch.mjs cannot monitor this service'),
    );
  }

  const seenSources = new Set();
  (service.sources ?? []).forEach((src, i) => {
    if (seenSources.has(src.url)) warnings.push(at(`sources[${i}].url: duplicate source ${src.url}`));
    seenSources.add(src.url);
  });

  return { errors, warnings };
}

/** Required `optional_host_permissions`: union of automation patterns and detection cookie origins. */
export function requiredHostPermissions(services) {
  const set = new Set();
  for (const s of services) {
    for (const o of s.optOuts ?? []) for (const p of o.automation?.hostPermissions ?? []) set.add(p);
    for (const c of s.detection?.cookies ?? []) {
      try {
        set.add(cookieOriginPattern(c.url));
      } catch {
        // reported by checkServiceInvariants
      }
    }
  }
  return [...set].sort();
}

// ---------------------------------------------------------------------------
// Manifest rewriting (preserves the rest of the file's formatting)
// ---------------------------------------------------------------------------

const PRINT_WIDTH = 110;

/**
 * Return manifest text with `optional_host_permissions` set to `patterns`, touching nothing else.
 * The array is printed the way Prettier would (one line if it fits in 110 columns).
 */
export function setOptionalHostPermissions(manifestText, patterns) {
  const re = /^([ \t]*)"optional_host_permissions"\s*:\s*\[[^\]]*\]/m;
  const m = re.exec(manifestText);
  const render = (indent, trailing) => {
    const oneLine = `${indent}"optional_host_permissions": [${patterns.map((p) => JSON.stringify(p)).join(', ')}]`;
    if (patterns.length === 0 || oneLine.length + trailing.length <= PRINT_WIDTH) return oneLine;
    const inner = patterns.map((p) => `${indent}  ${JSON.stringify(p)}`).join(',\n');
    return `${indent}"optional_host_permissions": [\n${inner}\n${indent}]`;
  };
  if (m) {
    const after = manifestText.slice(m.index + m[0].length);
    const trailing = /^\s*,/.test(after) ? ',' : '';
    return manifestText.slice(0, m.index) + render(m[1], trailing) + after;
  }
  // Key absent: insert it after "optional_permissions" or "permissions" if present, else re-serialise.
  const anchor = /^([ \t]*)"(?:optional_permissions|permissions)"\s*:\s*\[[^\]]*\],?[ \t]*$/m.exec(
    manifestText,
  );
  if (anchor) {
    const hadComma = /,\s*$/.test(anchor[0]);
    const base = anchor[0].replace(/,?\s*$/, '');
    const trailing = hadComma ? ',' : '';
    const inserted = `${base},\n${render(anchor[1], trailing)}${trailing}`;
    return (
      manifestText.slice(0, anchor.index) + inserted + manifestText.slice(anchor.index + anchor[0].length)
    );
  }
  const manifest = JSON.parse(manifestText);
  manifest.optional_host_permissions = patterns;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Main build
// ---------------------------------------------------------------------------

/**
 * Validate and (unless `check`) write every registry-derived output.
 *
 * @param {object} [options]
 * @param {string} [options.root] repository root (a temp dir in tests)
 * @param {boolean} [options.check] validate only; report stale outputs instead of writing them
 * @param {Date} [options.now] clock, for tests
 * @param {boolean} [options.readme] also update the README services table (default true)
 * @returns {Promise<{ ok: boolean, errors: string[], warnings: string[], outdated: string[], written: string[], registry: object|null, hostPermissions: string[] }>}
 */
export async function buildRegistry({ root = ROOT, check = false, now = new Date(), readme = true } = {}) {
  const errors = [];
  const warnings = [];
  const outdated = [];
  const written = [];
  const abs = (rel) => path.join(root, rel);
  const today = latestToday(now);
  const result = () => ({
    ok: errors.length === 0 && outdated.length === 0,
    errors,
    warnings,
    outdated,
    written,
    registry,
    hostPermissions,
  });
  let registry = null;
  let hostPermissions = [];

  const serviceSchema = await readJson(abs(PATHS.serviceSchema), PATHS.serviceSchema, errors);
  const crawlersSchema = await readJson(abs(PATHS.crawlersSchema), PATHS.crawlersSchema, errors);
  if (!serviceSchema || !crawlersSchema) return result();

  const ajv = createAjv();
  let validateService;
  let validateCrawlers;
  try {
    validateService = ajv.compile(serviceSchema);
    validateCrawlers = ajv.compile(crawlersSchema);
  } catch (err) {
    errors.push(`registry/schema: schema does not compile: ${err.message}`);
    return result();
  }

  // Services.
  let files = [];
  try {
    files = (await readdir(abs(PATHS.services))).filter((f) => f.endsWith('.json')).sort();
  } catch {
    errors.push(`${PATHS.services}: directory not found`);
  }
  if (files.length === 0 && errors.length === 0) errors.push(`${PATHS.services}: no service files found`);

  const services = [];
  const idToFile = new Map();
  const domainToFile = new Map();
  for (const name of files) {
    const rel = `${PATHS.services}/${name}`;
    const data = await readJson(abs(rel), rel, errors);
    if (data === undefined) continue;
    if (!validateService(data)) {
      errors.push(...formatAjvErrors(rel, validateService.errors));
      continue;
    }
    const inv = checkServiceInvariants(data, { file: rel, fileId: name.replace(/\.json$/, ''), today });
    errors.push(...inv.errors);
    warnings.push(...inv.warnings);
    if (idToFile.has(data.id)) {
      errors.push(`${rel} → id: "${data.id}" is already used by ${idToFile.get(data.id)}`);
      continue;
    }
    idToFile.set(data.id, rel);
    for (const d of data.domains) {
      if (domainToFile.has(d)) {
        warnings.push(`${rel} → domains: "${d}" is also listed by ${domainToFile.get(d)}`);
      } else domainToFile.set(d, rel);
    }
    services.push(data);
  }

  // Crawlers.
  let crawlers = [];
  const crawlersText = await readTextIfExists(abs(PATHS.crawlers));
  if (crawlersText === null) {
    warnings.push(`${PATHS.crawlers}: not found; the compiled registry will contain no crawlers`);
  } else {
    let data;
    try {
      data = JSON.parse(crawlersText);
    } catch (err) {
      errors.push(`${PATHS.crawlers}: invalid JSON: ${err.message}`);
    }
    if (data !== undefined) {
      if (!validateCrawlers(data)) {
        errors.push(...formatAjvErrors(PATHS.crawlers, validateCrawlers.errors));
      } else {
        const seen = new Map();
        data.crawlers.forEach((c, i) => {
          const key = c.token.toLowerCase();
          if (seen.has(key)) {
            errors.push(
              `${PATHS.crawlers} → crawlers[${i}].token: "${c.token}" duplicates crawlers[${seen.get(key)}]`,
            );
          } else seen.set(key, i);
          if (SEARCH_ENGINE_TOKENS.has(key)) {
            warnings.push(
              `${PATHS.crawlers} → crawlers[${i}].token: "${c.token}" is a regular search-engine crawler, not an AI crawler`,
            );
          }
        });
        crawlers = data.crawlers;
      }
    }
  }

  if (errors.length) return result();

  // Compile.
  const crawlerItemSchema = crawlersSchema.$defs?.crawler ?? {};
  const compiledServices = sortServices(services).map((s) => canonicalize(s, serviceSchema));
  const compiledCrawlers = sortCrawlers(crawlers).map((c) =>
    canonicalize(c, crawlerItemSchema, crawlersSchema),
  );

  const payload = (r) => JSON.stringify([r?.formatVersion, r?.services, r?.crawlers]);
  const [primaryOutput] = PATHS.outputs;
  let generatedAt = now.toISOString();
  const previousText = await readTextIfExists(abs(primaryOutput));
  if (previousText) {
    try {
      const previous = JSON.parse(previousText);
      const candidate = {
        formatVersion: FORMAT_VERSION,
        services: compiledServices,
        crawlers: compiledCrawlers,
      };
      if (payload(previous) === payload(candidate) && typeof previous.generatedAt === 'string') {
        generatedAt = previous.generatedAt; // content unchanged → keep the timestamp (deterministic rebuilds)
      }
    } catch {
      // unreadable previous output: regenerate
    }
  }
  registry = {
    formatVersion: FORMAT_VERSION,
    generatedAt,
    services: compiledServices,
    crawlers: compiledCrawlers,
  };
  const text = serializeRegistry(registry);

  for (const rel of PATHS.outputs) {
    const current = await readTextIfExists(abs(rel));
    if (current === text) continue;
    if (check) outdated.push(`${rel} is out of date`);
    else {
      await mkdir(path.dirname(abs(rel)), { recursive: true });
      await writeFile(abs(rel), text);
      written.push(rel);
    }
  }

  // Manifest optional host permissions.
  hostPermissions = requiredHostPermissions(compiledServices);
  const manifestText = await readTextIfExists(abs(PATHS.manifest));
  if (manifestText === null) {
    errors.push(`${PATHS.manifest}: not found`);
  } else {
    let manifest;
    try {
      manifest = JSON.parse(manifestText);
    } catch (err) {
      errors.push(`${PATHS.manifest}: invalid JSON: ${err.message}`);
    }
    if (manifest) {
      const current = manifest.optional_host_permissions ?? [];
      if (JSON.stringify(current) !== JSON.stringify(hostPermissions)) {
        if (check) {
          const missing = hostPermissions.filter((p) => !current.includes(p));
          const extra = current.filter((p) => !hostPermissions.includes(p));
          const parts = [];
          if (missing.length) parts.push(`missing ${missing.join(', ')}`);
          if (extra.length) parts.push(`not needed by the registry ${extra.join(', ')}`);
          if (!parts.length) parts.push('not sorted');
          outdated.push(`${PATHS.manifest} → optional_host_permissions: ${parts.join('; ')}`);
        } else {
          await writeFile(abs(PATHS.manifest), setOptionalHostPermissions(manifestText, hostPermissions));
          written.push(PATHS.manifest);
        }
      }
    }
  }

  // README services table.
  if (readme) {
    const r = await updateReadmeServices({ root, services: compiledServices, check });
    if (r.status === 'outdated') outdated.push('README.md services table is out of date');
    if (r.status === 'updated') written.push('README.md');
  }

  return result();
}

async function main(argv) {
  const check = argv.includes('--check');
  const strict = argv.includes('--strict');
  const res = await buildRegistry({ check });
  for (const w of res.warnings) console.warn(`warning: ${w}`);
  for (const e of res.errors) console.error(`error: ${e}`);
  if (res.errors.length) {
    console.error(`\n${res.errors.length} error(s). The registry was not compiled.`);
    return 1;
  }
  const n = res.registry.services.length;
  const c = res.registry.crawlers.length;
  if (check) {
    for (const o of res.outdated) console.error(`stale: ${o}`);
    if (res.outdated.length) {
      console.error('\nGenerated files are out of date. Run `npm run registry:build` and commit the result.');
      return 1;
    }
    console.log(`Registry OK: ${n} services, ${c} crawlers, ${res.hostPermissions.length} host permissions.`);
  } else {
    console.log(
      `Registry compiled: ${n} services, ${c} crawlers, ${res.hostPermissions.length} host permissions (generatedAt ${res.registry.generatedAt}).`,
    );
    console.log(
      res.written.length ? `Updated: ${res.written.join(', ')}` : 'All outputs were already up to date.',
    );
  }
  if (strict && res.warnings.length) {
    console.error(`\n${res.warnings.length} warning(s) and --strict was given.`);
    return 1;
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
