// Host-permission helpers shared by the background and extension pages.
//
// Security rule: the registry (which can be updated remotely) only *names* the
// host patterns an opt-out needs. The extension honours a pattern only if it is
// also declared in its own manifest, so a registry update can never widen the
// extension's access. Safe to import from pages: chrome.* is only touched
// inside functions.

import { HOST_PATTERN_RE } from './registry-validate.js';

const PATTERN_RE = /^(\*|https?):\/\/(\*|\*\.[^/*:]+|[^/*:]+)(\/.*)$/;

/**
 * @param {string} pattern a match pattern such as https://*.example.com/*
 * @returns {{ scheme: string, host: string, path: string } | null}
 */
export function parseMatchPattern(pattern) {
  if (pattern === '<all_urls>') return { scheme: '*', host: '*', path: '/*' };
  if (typeof pattern !== 'string') return null;
  const m = PATTERN_RE.exec(pattern);
  if (!m) return null;
  return { scheme: m[1], host: m[2].toLowerCase(), path: m[3] };
}

function schemeMatches(patternScheme, scheme) {
  return patternScheme === '*' ? scheme === 'http' || scheme === 'https' : patternScheme === scheme;
}

function hostMatches(patternHost, host) {
  if (patternHost === '*') return true;
  if (patternHost.startsWith('*.')) {
    const base = patternHost.slice(2);
    return host === base || host.endsWith(`.${base}`);
  }
  return host === patternHost;
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/** Does `url` match the match pattern? */
export function urlMatchesPattern(url, pattern) {
  const p = parseMatchPattern(pattern);
  if (!p) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (!schemeMatches(p.scheme, u.protocol.slice(0, -1))) return false;
  if (!hostMatches(p.host, u.hostname.toLowerCase())) return false;
  return p.path === '/*' || globToRegExp(p.path).test(u.pathname + u.search);
}

export function urlMatchesAny(url, patterns) {
  return Array.isArray(patterns) && patterns.some((p) => urlMatchesPattern(url, p));
}

/** Is every URL matched by `narrow` also matched by `broad`? */
export function patternCovers(broad, narrow) {
  const b = parseMatchPattern(broad);
  const n = parseMatchPattern(narrow);
  if (!b || !n) return false;
  const schemeOk =
    b.scheme === n.scheme || (b.scheme === '*' && (n.scheme === 'http' || n.scheme === 'https'));
  if (!schemeOk) return false;
  let hostOk;
  if (b.host === '*') hostOk = true;
  else if (n.host === '*') hostOk = false;
  else if (b.host.startsWith('*.')) {
    const base = b.host.slice(2);
    const nb = n.host.startsWith('*.') ? n.host.slice(2) : n.host;
    hostOk = nb === base || nb.endsWith(`.${base}`);
  } else hostOk = b.host === n.host;
  if (!hostOk) return false;
  return b.path === '/*' || b.path === n.path;
}

/**
 * Host patterns declared by the extension manifest (optional host permissions,
 * plus any host permissions granted at install time).
 * @param {object} [manifest]
 * @returns {string[]}
 */
export function manifestHostPatterns(manifest = globalThis.chrome?.runtime?.getManifest?.()) {
  if (!manifest) return [];
  const isHost = (p) => typeof p === 'string' && (p.includes('://') || p === '<all_urls>');
  return [
    ...new Set([
      ...(manifest.optional_host_permissions ?? []),
      ...(manifest.host_permissions ?? []),
      ...(manifest.optional_permissions ?? []).filter(isHost),
    ]),
  ].filter(isHost);
}

/** Is the pattern covered by something the manifest declares? */
export function isDeclared(pattern, declared = manifestHostPatterns()) {
  return declared.some((m) => patternCovers(m, pattern));
}

/**
 * Host patterns an opt-out's automation may use: those it lists in
 * `automation.hostPermissions` that are also declared in the manifest.
 * This is the list the UI must request before sending `runOptOut`.
 * @param {object} optOut registry opt-out
 * @param {string[]} [declared]
 * @returns {string[]}
 */
export function allowedHostPatterns(optOut, declared = manifestHostPatterns()) {
  const requested = optOut?.automation?.hostPermissions;
  if (!Array.isArray(requested)) return [];
  return [...new Set(requested)].filter((p) => HOST_PATTERN_RE.test(p) && isDeclared(p, declared));
}

/** `https://host/*` pattern for the origin of a URL, or null. */
export function originPattern(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    return `${u.origin}/*`;
  } catch {
    return null;
  }
}

/**
 * Origins the UI must request (together with the `cookies` permission) before
 * sending `detectAccounts`: every detection cookie origin declared in the manifest.
 * @param {object[]} services registry services
 * @param {string[]} [declared]
 * @returns {string[]}
 */
export function detectionOrigins(services, declared = manifestHostPatterns()) {
  const out = new Set();
  for (const s of services ?? []) {
    for (const c of s.detection?.cookies ?? []) {
      const p = originPattern(c.url);
      if (p && isDeclared(p, declared)) out.add(p);
    }
  }
  return [...out].sort();
}

/**
 * chrome.permissions.contains that never throws. An empty request is treated
 * as *not* granted so callers cannot be fooled by vacuous truth.
 * @param {{ origins?: string[], permissions?: string[] }} request
 */
export async function hasPermissions({ origins = [], permissions = [] }) {
  if (origins.length === 0 && permissions.length === 0) return false;
  try {
    return Boolean(await globalThis.chrome.permissions.contains({ origins, permissions }));
  } catch {
    return false;
  }
}
