// Creator tool generators: robots.txt rules, Spawning's ai.txt, "noai" meta tags and TDMRep.
// Pure ES module: no chrome.* APIs, no DOM, no network. Every output is copyable text with
// comments explaining what it does and, just as importantly, what it cannot do.
//
//   generateRobotsTxt({ crawlers, block, selectedTokens, keepSearch, date })  → string
//   generateAiTxt({ scope, types, date })                                      → string
//   generateMetaTags({ images })                                               → string
//   generateTdmRep({ policyUrl, location })                                    → { path, json, headers, meta }
//   selectCrawlers({ crawlers, block, selectedTokens, keepSearch })            → crawler[] (preview)

const PROJECT_URL = 'https://github.com/tayaa710/ai-opt-out';

/**
 * Regular search-engine crawlers. Blocking them removes a site from search results, so the
 * presets never block them; only an explicit custom selection can.
 */
export const SEARCH_ENGINE_TOKENS = Object.freeze([
  'Googlebot',
  'Googlebot-Image',
  'Googlebot-News',
  'Googlebot-Video',
  'Storebot-Google',
  'Bingbot',
  'msnbot',
  'Slurp',
  'DuckDuckBot',
  'Applebot',
  'Baiduspider',
  'YandexBot',
]);
const SEARCH_ENGINE_SET = new Set(SEARCH_ENGINE_TOKENS.map((t) => t.toLowerCase()));

/** Presets for `generateRobotsTxt({ block })`. */
export const ROBOTS_PRESETS = Object.freeze([
  Object.freeze({
    id: 'training',
    label: 'Block AI training crawlers',
    description:
      'Blocks crawlers that collect data to train AI models. AI search and assistants can still read and cite your pages.',
  }),
  Object.freeze({
    id: 'all-ai',
    label: 'Block all AI crawlers',
    description:
      'Also blocks AI assistants that fetch a page when a user asks, and (unless you keep them) AI search crawlers.',
  }),
  Object.freeze({
    id: 'custom',
    label: 'Choose crawlers',
    description: 'Pick exactly which user agents to block.',
  }),
]);

const PURPOSE_TEXT = {
  training: 'collects content to train AI models',
  search: 'indexes pages for AI search and answers',
  'user-triggered': 'fetches a page when a user asks an AI assistant to',
  mixed: 'used for AI training and other purposes',
};

/** A robots.txt product token: letters, digits, "-", "_" and "." only (RFC 9309 section 2.2.1). */
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function isToken(value) {
  return typeof value === 'string' && TOKEN_RE.test(value);
}

/** Single-line comment text: no line breaks, no control characters. */
function commentText(value) {
  return [...String(value ?? '').replace(/\s+/g, ' ')]
    .filter((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f)
    .join('')
    .trim();
}

function isoDate(date) {
  const d = date instanceof Date ? date : date ? new Date(date) : new Date();
  return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
}

/**
 * The crawlers a robots.txt configuration blocks.
 * @param {object} args
 * @param {object[]} args.crawlers entries from the compiled registry's `crawlers`
 * @param {'training'|'all-ai'|'custom'} [args.block]
 * @param {string[]} [args.selectedTokens] used when block is 'custom'; unknown valid tokens are kept
 * @param {boolean} [args.keepSearch] keep AI search crawlers allowed in 'all-ai' mode (default true)
 * @returns {object[]} crawler entries (custom tokens get operator "Other")
 */
export function selectCrawlers({
  crawlers = [],
  block = 'training',
  selectedTokens = [],
  keepSearch = true,
} = {}) {
  const valid = (crawlers ?? []).filter((c) => c && isToken(c.token));
  if (block === 'custom') {
    const wanted = new Map();
    for (const t of selectedTokens ?? []) {
      if (isToken(t) && !wanted.has(t.toLowerCase())) wanted.set(t.toLowerCase(), t);
    }
    const known = valid.filter((c) => wanted.has(c.token.toLowerCase()));
    const knownSet = new Set(known.map((c) => c.token.toLowerCase()));
    const extra = [...wanted.entries()]
      .filter(([key]) => !knownSet.has(key))
      .map(([, token]) => ({
        token,
        operator: SEARCH_ENGINE_SET.has(token.toLowerCase()) ? 'Search engines' : 'Other',
        purpose: SEARCH_ENGINE_SET.has(token.toLowerCase()) ? 'search-engine' : 'custom',
        respectsRobotsTxt: 'unknown',
      }));
    return [...known, ...extra];
  }
  return valid.filter((c) => {
    if (SEARCH_ENGINE_SET.has(c.token.toLowerCase())) return false;
    if (block === 'all-ai') return !(keepSearch && c.purpose === 'search');
    return c.purpose === 'training' || c.purpose === 'mixed';
  });
}

function groupByOperator(list) {
  const groups = new Map();
  for (const c of list) {
    const op = commentText(c.operator) || 'Other';
    if (!groups.has(op)) groups.set(op, []);
    groups.get(op).push(c);
  }
  const lower = (s) => s.toLowerCase();
  return [...groups.entries()].sort(([a], [b]) => {
    if (a === 'Other' || a === 'Search engines') return 1;
    if (b === 'Other' || b === 'Search engines') return -1;
    return lower(a) < lower(b) ? -1 : lower(a) > lower(b) ? 1 : 0;
  });
}

function describeCrawler(c) {
  if (c.purpose === 'search-engine' || SEARCH_ENGINE_SET.has(c.token.toLowerCase())) {
    return `${c.token}: a regular search-engine crawler. Blocking it removes your site from that search engine.`;
  }
  if (c.purpose === 'custom') return `${c.token}: added by you.`;
  const parts = [`${c.token}: ${PURPOSE_TEXT[c.purpose] ?? 'AI crawler'}.`];
  const notes = commentText(c.notes);
  if (notes) parts.push(/[.!?]$/.test(notes) ? notes : `${notes}.`);
  if (c.respectsRobotsTxt === false) {
    parts.push('Reported not to respect robots.txt; consider blocking it at your server or CDN as well.');
  }
  return parts.join(' ');
}

const MODE_LINES = {
  training: [
    'Mode: block AI training crawlers.',
    'Search engines, AI search crawlers and user-requested fetches stay allowed.',
  ],
  'all-ai': ['Mode: block all AI crawlers, including assistants that fetch pages on request.'],
  custom: ['Mode: custom selection.'],
};

/**
 * robots.txt rules that ask AI crawlers not to crawl a site.
 * @param {object} args see selectCrawlers; plus `date` for the header (default today)
 * @returns {string}
 */
export function generateRobotsTxt({
  crawlers = [],
  block = 'training',
  selectedTokens = [],
  keepSearch = true,
  date,
} = {}) {
  const mode = MODE_LINES[block] ? block : 'training';
  const chosen = selectCrawlers({ crawlers, block: mode, selectedTokens, keepSearch });
  const modeLines = [...MODE_LINES[mode]];
  if (mode === 'all-ai') {
    modeLines.push(
      keepSearch
        ? 'AI search crawlers stay allowed so your pages can still appear in AI search results.'
        : 'AI search crawlers are blocked too, so your pages may not appear in AI search results.',
    );
    modeLines.push('Regular search engines (Googlebot, Bingbot, ...) stay allowed.');
  }

  const lines = [
    `# AI crawler rules generated by NoTrain on ${isoDate(date)} (${PROJECT_URL})`,
    ...modeLines.map((l) => `# ${l}`),
    '#',
    '# How to use: add these lines to the robots.txt file at the root of your site',
    '# (https://your-site.example/robots.txt), next to any rules you already have.',
    '# Each crawler follows only the group that names it, so these rules do not change',
    '# what your existing "User-agent: *" rules allow for other crawlers.',
    '#',
    '# What it does and does not do: robots.txt (RFC 9309) is a voluntary standard.',
    '# Reputable crawlers follow it, but it cannot technically stop a crawler that ignores it,',
    '# and it does not remove content that has already been collected.',
  ];

  if (chosen.length === 0) {
    lines.push('', '# No crawlers selected, so there is nothing to block.');
    return `${lines.join('\n')}\n`;
  }

  for (const [operator, list] of groupByOperator(chosen)) {
    lines.push('', `# ${operator}`);
    for (const c of list) lines.push(`# ${describeCrawler(c)}`);
    for (const c of list) lines.push(`User-agent: ${c.token}`);
    lines.push('Disallow: /');
  }
  return `${lines.join('\n')}\n`;
}

/** File extensions per content type, following Spawning's ai.txt generator. */
export const AI_TXT_TYPES = Object.freeze({
  text: Object.freeze(['txt', 'pdf', 'doc', 'docx', 'odt', 'rtf', 'tex', 'md', 'html', 'htm']),
  images: Object.freeze([
    'jpg',
    'jpeg',
    'png',
    'gif',
    'webp',
    'avif',
    'bmp',
    'tif',
    'tiff',
    'svg',
    'ico',
    'heic',
  ]),
  audio: Object.freeze(['mp3', 'wav', 'aac', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aiff', 'wma']),
  video: Object.freeze(['mp4', 'webm', 'mov', 'avi', 'mkv', 'wmv', 'flv', 'm4v']),
  code: Object.freeze([
    'js',
    'ts',
    'py',
    'java',
    'c',
    'cpp',
    'h',
    'cs',
    'go',
    'rb',
    'php',
    'rs',
    'swift',
    'kt',
    'sh',
    'sql',
  ]),
});

/**
 * An ai.txt file in the format proposed by Spawning (spawning.ai), served at /ai.txt.
 * @param {object} [args]
 * @param {'all'|'types'} [args.scope] 'all' disallows everything; 'types' only the chosen file types
 * @param {Array<keyof AI_TXT_TYPES>} [args.types] used when scope is 'types'
 * @param {Date|string} [args.date]
 * @returns {string}
 */
export function generateAiTxt({ scope = 'all', types = [], date } = {}) {
  const chosen = (types ?? []).filter((t) => Object.hasOwn(AI_TXT_TYPES, t));
  const lines = [
    '# Spawning AI',
    '# Prevent datasets from using the following file types',
    '#',
    `# ai.txt generated by NoTrain on ${isoDate(date)} (${PROJECT_URL})`,
    '# Save this file as https://your-site.example/ai.txt',
    '#',
    "# ai.txt is a proposal by Spawning. It is read by Spawning's tools and by the datasets and",
    '# AI companies that have agreed to honour it, not by most crawlers. It is voluntary and does',
    '# not remove content already collected. Keep your robots.txt rules as well.',
    '',
    'User-Agent: *',
  ];
  if (scope === 'types' && chosen.length) {
    for (const t of chosen) {
      lines.push(`# ${t[0].toUpperCase()}${t.slice(1)}`);
      for (const ext of AI_TXT_TYPES[t]) lines.push(`Disallow: *.${ext}`);
    }
  } else {
    lines.push('Disallow: /');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * HTML meta tags (and the equivalent HTTP header) with the "noai" and "noimageai" directives.
 * @param {object} [args]
 * @param {boolean} [args.images] include "noimageai" (default true)
 * @returns {string}
 */
export function generateMetaTags({ images = true } = {}) {
  const directives = images ? 'noai, noimageai' : 'noai';
  return [
    '<!--',
    '  Ask AI tools not to use this page (and its images) for training. Put this inside <head>',
    '  on every page, or send the equivalent HTTP response header:',
    `    X-Robots-Tag: ${directives}`,
    '',
    '  "noai" and "noimageai" are informal directives first used by DeviantArt. Some platforms',
    '  and dataset builders honour them, but major crawlers such as Googlebot and GPTBot do not;',
    '  search engines simply ignore them, so they do not affect your search ranking.',
    '  Use them in addition to robots.txt rules, not instead of them.',
    '-->',
    `<meta name="robots" content="${directives}">`,
    '',
  ].join('\n');
}

/**
 * TDM Reservation Protocol (TDMRep, W3C Community Group report): declares that text and data
 * mining rights are reserved, which is the machine-readable opt-out from the EU text and data
 * mining exception (Directive (EU) 2019/790, Article 4(3)).
 *
 * @param {object} [args]
 * @param {string} [args.policyUrl] https URL of your TDM policy / licensing terms (optional)
 * @param {string} [args.location] path the reservation applies to (default "/", the whole site)
 * @returns {{ path: string, json: string, headers: string, meta: string }}
 */
export function generateTdmRep({ policyUrl, location = '/' } = {}) {
  let policy = null;
  if (typeof policyUrl === 'string' && policyUrl.trim()) {
    let u;
    try {
      u = new URL(policyUrl.trim());
    } catch {
      throw new TypeError('generateTdmRep: policyUrl must be an absolute https URL');
    }
    if (u.protocol !== 'https:') throw new TypeError('generateTdmRep: policyUrl must use https');
    policy = u.href;
  }
  const loc = typeof location === 'string' && /^\/[^\s"]*$/.test(location) ? location : '/';
  const entry = { location: loc, 'tdm-reservation': 1 };
  if (policy) entry['tdm-policy'] = policy;

  const json = `${JSON.stringify([entry], null, 2)}\n`;
  const headers = [
    '# HTTP response headers (alternative to, or in addition to, the file above).',
    '# Add them to every response, for example in your web server or CDN configuration.',
    'tdm-reservation: 1',
    ...(policy ? [`tdm-policy: ${policy}`] : []),
    '',
  ].join('\n');
  const meta = [
    '<!-- TDM Reservation Protocol: text and data mining rights are reserved for this page. -->',
    '<meta name="tdm-reservation" content="1">',
    ...(policy ? [`<meta name="tdm-policy" content="${policy.replace(/"/g, '&quot;')}">`] : []),
    '',
  ].join('\n');
  return { path: '/.well-known/tdmrep.json', json, headers, meta };
}
