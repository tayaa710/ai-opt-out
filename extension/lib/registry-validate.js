// Structural validation of a compiled registry (bundled or fetched remotely).
// The remote registry is treated as untrusted data: every field the extension
// relies on is checked, URLs must be https, unknown fields are dropped, and a
// service that fails validation is dropped (never partially trusted). An
// invalid automation recipe is removed from its opt-out (guided mode still
// works). Pure module: no chrome.* access.

import { REGISTRY_FORMAT_VERSION } from './constants.js';

export const MAX_SERVICES = 2000;
export const MAX_CRAWLERS = 1000;
/** Reject registries claiming to be generated further in the future than this. */
export const MAX_CLOCK_SKEW_MS = 2 * 24 * 60 * 60 * 1000;
const MAX_TARGET_DEPTH = 4;
const MAX_STEPS = 50;

export const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SINCE_RE = /^\d{4}(-\d{2}){0,2}$/;
const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const HOST_PATTERN_RE = /^https:\/\/[a-z0-9.*-]+\/\*$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const CATEGORIES = Object.freeze([
  'ai-assistant',
  'social',
  'professional',
  'productivity',
  'communication',
  'creative',
  'developer',
  'search-browser',
  'shopping',
  'other',
]);
const TRAINS = ['yes', 'no', 'conditional', 'unknown'];
const DEFAULT_STATES = ['opted_in', 'opted_out', 'no_choice', 'varies_by_region', 'not_applicable'];
const DATA_TYPES = [
  'chats',
  'files',
  'voice',
  'images',
  'video',
  'posts',
  'comments',
  'messages',
  'code',
  'documents',
  'profile',
  'activity',
  'feedback',
  'creative-works',
];
export const REGISTRY_REGIONS = Object.freeze([
  'ALL',
  'EU',
  'UK',
  'CH',
  'US',
  'US-CA',
  'CA',
  'AU',
  'BR',
  'IN',
  'JP',
  'OTHER',
]);
const NOTE_REGIONS = REGISTRY_REGIONS.filter((r) => r !== 'ALL');
export const OPT_OUT_TYPES = Object.freeze(['toggle', 'form', 'email', 'account-deletion', 'none']);
const EFFORTS = ['quick', 'moderate', 'involved'];
const CONFIDENCE = ['high', 'medium', 'experimental'];
const ROLES = [
  'switch',
  'checkbox',
  'button',
  'link',
  'tab',
  'menuitem',
  'radio',
  'option',
  'dialog',
  'textbox',
  'combobox',
];
export const STEP_ACTIONS = Object.freeze(['waitFor', 'click', 'setToggle', 'assertToggle', 'wait']);
const TARGET_ACTIONS = ['waitFor', 'click', 'setToggle', 'assertToggle'];
export const SEVERITIES = Object.freeze(['info', 'warning', 'critical']);
const CRAWLER_PURPOSES = ['training', 'search', 'user-triggered', 'mixed'];

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isStr(v, min = 1, max = Infinity) {
  return typeof v === 'string' && v.length >= min && v.length <= max;
}

function isInt(v, min = -Infinity, max = Infinity) {
  return Number.isInteger(v) && v >= min && v <= max;
}

/** True for an absolute https URL without embedded credentials. */
export function isHttpsUrl(v) {
  if (typeof v !== 'string' || v.length > 2048 || !v.startsWith('https://')) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.hostname !== '' && !u.username && !u.password;
  } catch {
    return false;
  }
}

export function isValidDate(v) {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

class Collector {
  constructor() {
    /** @type {string[]} */
    this.errors = [];
  }
  check(cond, path, msg) {
    if (!cond) this.errors.push(`${path}: ${msg}`);
    return Boolean(cond);
  }
  get ok() {
    return this.errors.length === 0;
  }
}

/**
 * @param {any} raw
 * @param {string} path
 * @param {Collector} c
 * @param {number} depth
 */
function cleanTarget(raw, path, c, depth = 0) {
  if (!c.check(isObj(raw), path, 'must be an object')) return null;
  if (!c.check(depth <= MAX_TARGET_DEPTH, path, 'nested too deeply')) return null;
  const out = {};
  if (raw.selector !== undefined && c.check(isStr(raw.selector, 1, 500), `${path}.selector`, 'invalid')) {
    out.selector = raw.selector;
  }
  if (raw.role !== undefined && c.check(ROLES.includes(raw.role), `${path}.role`, 'unknown role')) {
    out.role = raw.role;
  }
  if (raw.text !== undefined) {
    const ok =
      Array.isArray(raw.text) &&
      raw.text.length >= 1 &&
      raw.text.length <= 20 &&
      raw.text.every((t) => isStr(t, 2, 200));
    if (c.check(ok, `${path}.text`, 'must be 1-20 strings')) out.text = [...raw.text];
  }
  if (raw.within !== undefined) {
    const w = cleanTarget(raw.within, `${path}.within`, c, depth + 1);
    if (w) out.within = w;
  }
  c.check(Object.keys(out).length > 0, path, 'needs selector, role, text or within');
  return out;
}

function cleanStep(raw, path, c) {
  if (!c.check(isObj(raw), path, 'must be an object')) return null;
  if (!c.check(STEP_ACTIONS.includes(raw.action), `${path}.action`, 'unknown action')) return null;
  const out = { action: raw.action };
  if (TARGET_ACTIONS.includes(raw.action) || raw.target !== undefined) {
    const t = cleanTarget(raw.target, `${path}.target`, c);
    if (t) out.target = t;
  }
  if (raw.action === 'setToggle' || raw.action === 'assertToggle' || raw.state !== undefined) {
    if (c.check(raw.state === 'on' || raw.state === 'off', `${path}.state`, 'must be on or off')) {
      out.state = raw.state;
    }
  }
  if (raw.action === 'wait' || raw.ms !== undefined) {
    if (c.check(isInt(raw.ms, 0, 10000), `${path}.ms`, 'must be 0-10000')) out.ms = raw.ms;
  }
  if (
    raw.timeoutMs !== undefined &&
    c.check(isInt(raw.timeoutMs, 0, 60000), `${path}.timeoutMs`, 'invalid')
  ) {
    out.timeoutMs = raw.timeoutMs;
  }
  if (raw.optional !== undefined && c.check(typeof raw.optional === 'boolean', `${path}.optional`, 'bool')) {
    out.optional = raw.optional;
  }
  if (
    raw.description !== undefined &&
    c.check(isStr(raw.description, 0, 200), `${path}.description`, 'bad')
  ) {
    out.description = raw.description;
  }
  return out;
}

function cleanSteps(raw, path, c, { min = 1 } = {}) {
  if (!c.check(Array.isArray(raw) && raw.length >= min && raw.length <= MAX_STEPS, path, 'invalid steps')) {
    return null;
  }
  return raw.map((s, i) => cleanStep(s, `${path}[${i}]`, c));
}

/**
 * @returns {{ automation: object|null, errors: string[] }}
 */
export function validateAutomation(raw, path = 'automation') {
  const c = new Collector();
  const out = {};
  if (!c.check(isObj(raw), path, 'must be an object')) return { automation: null, errors: c.errors };
  if (c.check(CONFIDENCE.includes(raw.confidence), `${path}.confidence`, 'unknown')) {
    out.confidence = raw.confidence;
  }
  const hp = raw.hostPermissions;
  const hpOk =
    Array.isArray(hp) &&
    hp.length >= 1 &&
    hp.length <= 20 &&
    hp.every((p) => isStr(p, 1, 300) && HOST_PATTERN_RE.test(p));
  if (c.check(hpOk, `${path}.hostPermissions`, 'must be https://host/* patterns')) {
    out.hostPermissions = [...new Set(hp)];
  }
  if (raw.loginIndicators !== undefined) {
    if (
      c.check(
        Array.isArray(raw.loginIndicators) && raw.loginIndicators.length <= 20,
        `${path}.loginIndicators`,
        'bad',
      )
    ) {
      out.loginIndicators = raw.loginIndicators.map((t, i) =>
        cleanTarget(t, `${path}.loginIndicators[${i}]`, c),
      );
    }
  }
  const steps = cleanSteps(raw.steps, `${path}.steps`, c);
  if (steps) out.steps = steps;
  if (raw.verify !== undefined) {
    const verify = cleanSteps(raw.verify, `${path}.verify`, c, { min: 0 });
    if (verify) out.verify = verify;
  }
  return c.ok ? { automation: out, errors: [] } : { automation: null, errors: c.errors };
}

function cleanOptOut(raw, path, c, warnings) {
  if (!c.check(isObj(raw), path, 'must be an object')) return null;
  const out = {};
  if (c.check(isStr(raw.id, 1, 80) && ID_RE.test(raw.id), `${path}.id`, 'invalid id')) out.id = raw.id;
  if (c.check(OPT_OUT_TYPES.includes(raw.type), `${path}.type`, 'unknown type')) out.type = raw.type;
  if (c.check(isStr(raw.title, 1, 200), `${path}.title`, 'required')) out.title = raw.title;
  if (
    raw.description !== undefined &&
    c.check(isStr(raw.description, 0, 1000), `${path}.description`, 'bad')
  ) {
    out.description = raw.description;
  }
  if (raw.url !== undefined && c.check(isHttpsUrl(raw.url), `${path}.url`, 'must be an https URL')) {
    out.url = raw.url;
  }
  if (out.type === 'toggle' || out.type === 'form') c.check(out.url, `${path}.url`, 'required for this type');
  const regions = Array.isArray(raw.regions) ? raw.regions.filter((r) => REGISTRY_REGIONS.includes(r)) : [];
  if (c.check(regions.length > 0, `${path}.regions`, 'needs at least one known region')) {
    out.regions = [...new Set(regions)];
  }
  if (c.check(EFFORTS.includes(raw.effort), `${path}.effort`, 'unknown')) out.effort = raw.effort;
  const stepsOk =
    Array.isArray(raw.steps) &&
    raw.steps.length >= 1 &&
    raw.steps.length <= 30 &&
    raw.steps.every((s) => isStr(s, 1, 500));
  if (c.check(stepsOk, `${path}.steps`, 'must be 1-30 strings')) out.steps = [...raw.steps];
  if (c.check(isStr(raw.effect, 1, 600), `${path}.effect`, 'required')) out.effect = raw.effect;
  if (
    raw.perDevice !== undefined &&
    c.check(typeof raw.perDevice === 'boolean', `${path}.perDevice`, 'bool')
  ) {
    out.perDevice = raw.perDevice;
  }
  if (raw.automation !== undefined) {
    const { automation, errors } = validateAutomation(raw.automation, `${path}.automation`);
    if (automation) out.automation = automation;
    else warnings.push(...errors.map((e) => `${e} (automation removed)`));
  }
  return out;
}

/**
 * Validates and sanitises one service entry.
 * @returns {{ service: object|null, errors: string[], warnings: string[] }}
 */
export function validateService(raw) {
  const c = new Collector();
  /** @type {string[]} */
  const warnings = [];
  if (!isObj(raw)) return { service: null, errors: ['service: must be an object'], warnings };
  const s = {};
  if (c.check(isStr(raw.id, 1, 80) && ID_RE.test(raw.id), 'id', 'invalid id')) s.id = raw.id;
  if (c.check(isStr(raw.name, 1, 100), 'name', 'required')) s.name = raw.name;
  if (c.check(isStr(raw.company, 1, 120), 'company', 'required')) s.company = raw.company;
  s.category = CATEGORIES.includes(raw.category) ? raw.category : 'other';
  if (raw.brandColor !== undefined) {
    if (typeof raw.brandColor === 'string' && COLOR_RE.test(raw.brandColor)) s.brandColor = raw.brandColor;
    else warnings.push('brandColor: invalid (dropped)');
  }
  const domainsOk =
    Array.isArray(raw.domains) &&
    raw.domains.length >= 1 &&
    raw.domains.length <= 50 &&
    raw.domains.every((d) => isStr(d, 4, 253) && DOMAIN_RE.test(d));
  if (c.check(domainsOk, 'domains', 'must be 1-50 hostnames')) s.domains = [...new Set(raw.domains)];
  if (c.check(isStr(raw.summary, 1, 400), 'summary', 'required')) s.summary = raw.summary;

  const t = raw.training;
  if (c.check(isObj(t), 'training', 'must be an object')) {
    const tr = {};
    tr.trainsOnUserData = TRAINS.includes(t.trainsOnUserData) ? t.trainsOnUserData : 'unknown';
    if (c.check(DEFAULT_STATES.includes(t.defaultState), 'training.defaultState', 'unknown')) {
      tr.defaultState = t.defaultState;
    }
    tr.dataTypes = Array.isArray(t.dataTypes)
      ? [...new Set(t.dataTypes.filter((d) => DATA_TYPES.includes(d)))]
      : [];
    if (c.check(isStr(t.details, 1, 2000), 'training.details', 'required')) tr.details = t.details;
    if (t.since !== undefined && typeof t.since === 'string' && SINCE_RE.test(t.since)) tr.since = t.since;
    tr.retroactiveRemoval = t.retroactiveRemoval === true;
    if (isObj(t.regionNotes)) {
      const notes = {};
      for (const [k, v] of Object.entries(t.regionNotes)) {
        if (NOTE_REGIONS.includes(k) && isStr(v, 1, 1000)) notes[k] = v;
      }
      if (Object.keys(notes).length) tr.regionNotes = notes;
    }
    s.training = tr;
  }

  if (
    c.check(
      Array.isArray(raw.optOuts) && raw.optOuts.length >= 1 && raw.optOuts.length <= 30,
      'optOuts',
      'invalid',
    )
  ) {
    s.optOuts = raw.optOuts.map((o, i) => cleanOptOut(o, `optOuts[${i}]`, c, warnings));
    const ids = s.optOuts.map((o) => o?.id).filter(Boolean);
    c.check(new Set(ids).size === ids.length, 'optOuts', 'duplicate opt-out ids');
  }

  if (raw.detection !== undefined && isObj(raw.detection) && Array.isArray(raw.detection.cookies)) {
    const cookies = raw.detection.cookies
      .filter((k) => isObj(k) && isHttpsUrl(k.url) && isStr(k.name, 1, 200))
      .slice(0, 20)
      .map((k) => ({ url: k.url, name: k.name }));
    if (cookies.length) s.detection = { cookies };
  }

  if (isObj(raw.contacts)) {
    const ct = {};
    const r = raw.contacts;
    if (isStr(r.privacyEmail, 3, 254) && EMAIL_RE.test(r.privacyEmail)) ct.privacyEmail = r.privacyEmail;
    if (isStr(r.dpoEmail, 3, 254) && EMAIL_RE.test(r.dpoEmail)) ct.dpoEmail = r.dpoEmail;
    if (isHttpsUrl(r.privacyRequestUrl)) ct.privacyRequestUrl = r.privacyRequestUrl;
    if (isStr(r.postalAddress, 1, 300)) ct.postalAddress = r.postalAddress;
    if (Object.keys(ct).length) s.contacts = ct;
  }

  if (Array.isArray(raw.policyUrls)) {
    const urls = raw.policyUrls.filter(isHttpsUrl).slice(0, 20);
    if (urls.length) s.policyUrls = urls;
  }

  const sources = Array.isArray(raw.sources)
    ? raw.sources
        .filter((x) => isObj(x) && isStr(x.title, 1, 300) && isHttpsUrl(x.url))
        .slice(0, 50)
        .map((x) => ({
          title: x.title,
          url: x.url,
          ...(isValidDate(x.accessed) ? { accessed: x.accessed } : {}),
        }))
    : [];
  if (c.check(sources.length > 0, 'sources', 'needs at least one https source')) s.sources = sources;
  if (c.check(isValidDate(raw.lastVerified), 'lastVerified', 'must be YYYY-MM-DD'))
    s.lastVerified = raw.lastVerified;
  if (c.check(isInt(raw.policyVersion, 1, 1e6), 'policyVersion', 'must be a positive integer')) {
    s.policyVersion = raw.policyVersion;
  }
  const changelog = Array.isArray(raw.changelog)
    ? raw.changelog
        .filter(
          (e) =>
            isObj(e) &&
            isInt(e.version, 1, 1e6) &&
            isValidDate(e.date) &&
            isStr(e.summary, 1, 600) &&
            SEVERITIES.includes(e.severity),
        )
        .slice(0, 200)
        .map((e) => ({ version: e.version, date: e.date, summary: e.summary, severity: e.severity }))
    : [];
  if (c.check(changelog.length > 0, 'changelog', 'needs at least one valid entry')) s.changelog = changelog;

  return c.ok ? { service: s, errors: [], warnings } : { service: null, errors: c.errors, warnings };
}

function cleanCrawler(raw) {
  if (!isObj(raw) || !isStr(raw.token, 1, 100) || !isStr(raw.operator, 1, 120)) return null;
  const out = { token: raw.token, operator: raw.operator };
  if (CRAWLER_PURPOSES.includes(raw.purpose)) out.purpose = raw.purpose;
  if (
    raw.respectsRobotsTxt === true ||
    raw.respectsRobotsTxt === false ||
    raw.respectsRobotsTxt === 'unknown'
  ) {
    out.respectsRobotsTxt = raw.respectsRobotsTxt;
  }
  if (isHttpsUrl(raw.docsUrl)) out.docsUrl = raw.docsUrl;
  if (isStr(raw.notes, 1, 1000)) out.notes = raw.notes;
  return out;
}

/**
 * Validates a compiled registry.
 * @param {any} raw parsed JSON
 * @param {{ now?: Date }} [options]
 * @returns {{ ok: true, registry: object, dropped: {id: string|null, errors: string[]}[], warnings: string[] }
 *   | { ok: false, error: string }}
 */
export function validateRegistry(raw, { now = new Date() } = {}) {
  if (!isObj(raw)) return { ok: false, error: 'Registry is not a JSON object' };
  if (raw.formatVersion !== REGISTRY_FORMAT_VERSION) {
    return { ok: false, error: `Unsupported registry formatVersion ${JSON.stringify(raw.formatVersion)}` };
  }
  const generated = typeof raw.generatedAt === 'string' ? Date.parse(raw.generatedAt) : NaN;
  if (Number.isNaN(generated)) return { ok: false, error: 'Registry generatedAt is not a valid date' };
  if (generated > now.getTime() + MAX_CLOCK_SKEW_MS) {
    return { ok: false, error: 'Registry generatedAt is in the future' };
  }
  if (!Array.isArray(raw.services)) return { ok: false, error: 'Registry services must be an array' };
  if (raw.services.length > MAX_SERVICES) return { ok: false, error: 'Registry has too many services' };

  const services = [];
  const dropped = [];
  const warnings = [];
  const seen = new Set();
  for (const entry of raw.services) {
    const { service, errors, warnings: w } = validateService(entry);
    const id = isObj(entry) && typeof entry.id === 'string' ? entry.id : null;
    if (!service) {
      dropped.push({ id, errors });
      continue;
    }
    if (seen.has(service.id)) {
      dropped.push({ id, errors: ['duplicate service id'] });
      continue;
    }
    seen.add(service.id);
    services.push(service);
    warnings.push(...w.map((x) => `${service.id}: ${x}`));
  }
  const crawlers = Array.isArray(raw.crawlers)
    ? raw.crawlers.slice(0, MAX_CRAWLERS).map(cleanCrawler).filter(Boolean)
    : [];
  return {
    ok: true,
    registry: {
      formatVersion: REGISTRY_FORMAT_VERSION,
      generatedAt: new Date(generated).toISOString(),
      services,
      crawlers,
    },
    dropped,
    warnings,
  };
}

/** Empty but valid registry, used when the bundled copy is missing or broken. */
export function emptyRegistry() {
  return {
    formatVersion: REGISTRY_FORMAT_VERSION,
    generatedAt: new Date(0).toISOString(),
    services: [],
    crawlers: [],
  };
}
