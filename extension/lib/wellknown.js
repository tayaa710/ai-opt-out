// `/.well-known/ai-training-opt-out` probe (ARCHITECTURE.md, spec/). The popup
// (opened by the user, so activeTab applies) asks the background to fetch the
// document same-origin from inside the tab; the background validates it.

import { REGISTRY_REGIONS, isHttpsUrl, isValidDate } from './registry-validate.js';

export const WELL_KNOWN_PATH = '/.well-known/ai-training-opt-out';
export const WELL_KNOWN_MAX_BYTES = 64 * 1024;
export const WELL_KNOWN_TIMEOUT_MS = 3_000;

const TRAINS = ['yes', 'no', 'conditional'];
const DEFAULTS = ['opted_in', 'opted_out', 'no_choice'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Public suffixes with two labels (common ccTLD second levels) and hosting
// platforms where unrelated sites share a parent domain. Without a full Public
// Suffix List this keeps "same registrable domain" conservative.
const TWO_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'nhs.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
  'co.nz', 'org.nz', 'net.nz', 'govt.nz', 'ac.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'co.in', 'net.in', 'org.in', 'gov.in', 'firm.in', 'gen.in', 'ind.in',
  'com.cn', 'net.cn', 'org.cn', 'com.hk', 'com.tw', 'co.kr', 'com.sg', 'com.my', 'com.ph', 'co.id',
  'co.th', 'com.vn', 'com.mx', 'com.ar', 'com.co', 'com.tr', 'co.za', 'co.il', 'com.ua', 'com.pl',
  'github.io', 'gitlab.io', 'herokuapp.com', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev',
  'web.app', 'firebaseapp.com', 'appspot.com', 'blogspot.com', 'wordpress.com', 'azurewebsites.net',
  'cloudfront.net', 'onrender.com', 'fly.dev', 'glitch.me', 'substack.com', 'tumblr.com',
]); // prettier-ignore

/** Best-effort registrable domain ("eTLD+1") of a hostname. */
export function registrableDomain(hostname) {
  const host = String(hostname).toLowerCase().replace(/\.$/, '');
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host; // IP address
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join('.');
  return TWO_LABEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

export function sameSite(hostA, hostB) {
  return registrableDomain(hostA) === registrableDomain(hostB);
}

function isStr(v, max) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

/**
 * Validates a well-known document fetched from `host` and returns a clean copy
 * with only the fields defined by the spec (unknown fields are ignored).
 * @param {any} doc parsed JSON
 * @param {string} host hostname the document was served from
 * @returns {{ ok: true, document: object } | { ok: false, errors: string[] }}
 */
export function validateWellKnown(doc, host) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, errors: ['document must be a JSON object'] };
  }
  const errors = [];
  const out = {};
  if (doc.version === 1) out.version = 1;
  else errors.push('version must be 1');
  if (TRAINS.includes(doc.trains_on_user_content)) out.trains_on_user_content = doc.trains_on_user_content;
  else errors.push('trains_on_user_content must be yes, no or conditional');
  if (isValidDate(doc.last_updated)) out.last_updated = doc.last_updated;
  else errors.push('last_updated must be a YYYY-MM-DD date');

  const optOutRequired = out.trains_on_user_content !== 'no';
  if (doc.opt_out_url !== undefined) {
    const ok = isHttpsUrl(doc.opt_out_url) && sameSite(new URL(doc.opt_out_url).hostname, host);
    if (ok) out.opt_out_url = doc.opt_out_url;
    else if (optOutRequired) errors.push(`opt_out_url must be an https URL on ${registrableDomain(host)}`);
  } else if (optOutRequired) {
    errors.push('opt_out_url is required unless trains_on_user_content is "no"');
  }

  if (isStr(doc.name, 100)) out.name = doc.name.trim();
  if (DEFAULTS.includes(doc.default)) out.default = doc.default;
  if (isHttpsUrl(doc.policy_url)) out.policy_url = doc.policy_url;
  if (Array.isArray(doc.data_types)) {
    const types = doc.data_types.filter((t) => isStr(t, 50)).slice(0, 20);
    if (types.length) out.data_types = types;
  }
  if (Array.isArray(doc.regions)) {
    const regions = [...new Set(doc.regions.filter((r) => REGISTRY_REGIONS.includes(r)))];
    if (regions.length) out.regions = regions;
  }
  if (typeof doc.contact === 'string') {
    if ((doc.contact.length <= 254 && EMAIL_RE.test(doc.contact)) || isHttpsUrl(doc.contact)) {
      out.contact = doc.contact;
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, document: out };
}

/**
 * Runs inside the tab's isolated world (serialised by chrome.scripting, so it
 * must be self-contained). Same-origin GET without cookies, bounded in time
 * and size. Returns the raw text; parsing and validation happen in the
 * background.
 */
export async function fetchWellKnownInPage(path, maxBytes, timeoutMs) {
  const origin = location.origin;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path, {
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-cache',
      redirect: 'follow',
      headers: { Accept: 'application/json' },
    });
    if (new URL(res.url).origin !== origin) return { origin, error: 'redirected_offsite' };
    if (res.status === 404 || res.status === 410) return { origin, error: 'not_found' };
    if (!res.ok) return { origin, error: `http_${res.status}` };
    if (Number(res.headers.get('content-length')) > maxBytes) return { origin, error: 'too_large' };
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        reader.cancel().catch(() => {});
        return { origin, error: 'too_large' };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.byteLength;
    }
    return { origin, text: new TextDecoder().decode(bytes) };
  } catch {
    return { origin, error: controller.signal.aborted ? 'timeout' : 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Handles `probeWellKnown`. Never throws for page-related problems; returns
 * `{ found: false, url, error }` instead (error codes: tab_not_found,
 * unsupported_page, no_access, not_found, timeout, too_large, network_error,
 * redirected_offsite, http_<status>, invalid_json, invalid_document).
 * @param {{ tabId: number }} payload
 */
export async function probeWellKnown({ tabId }) {
  const chrome = globalThis.chrome;
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { found: false, url: null, error: 'tab_not_found' };
  }
  if (!tab.url) return { found: false, url: null, error: 'no_access' };
  let page;
  try {
    page = new URL(tab.url);
  } catch {
    return { found: false, url: null, error: 'unsupported_page' };
  }
  if (page.protocol !== 'https:') return { found: false, url: null, error: 'unsupported_page' };

  let result;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: fetchWellKnownInPage,
      args: [WELL_KNOWN_PATH, WELL_KNOWN_MAX_BYTES, WELL_KNOWN_TIMEOUT_MS],
    });
    result = res?.result;
  } catch {
    return { found: false, url: `${page.origin}${WELL_KNOWN_PATH}`, error: 'no_access' };
  }
  if (!result || typeof result.origin !== 'string') {
    return { found: false, url: `${page.origin}${WELL_KNOWN_PATH}`, error: 'no_access' };
  }
  // The tab may have navigated since tabs.get: trust the origin the page reported.
  let origin;
  try {
    origin = new URL(result.origin);
  } catch {
    return { found: false, url: null, error: 'unsupported_page' };
  }
  if (origin.protocol !== 'https:') return { found: false, url: null, error: 'unsupported_page' };
  const url = `${origin.origin}${WELL_KNOWN_PATH}`;
  if (result.error) return { found: false, url, error: String(result.error).slice(0, 40) };
  if (typeof result.text !== 'string') return { found: false, url, error: 'invalid_json' };
  let doc;
  try {
    doc = JSON.parse(result.text);
  } catch {
    return { found: false, url, error: 'invalid_json' };
  }
  const v = validateWellKnown(doc, origin.hostname);
  if (!v.ok) return { found: false, url, error: 'invalid_document', problems: v.errors };
  return { found: true, url, document: v.document };
}
