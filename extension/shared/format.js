// Formatting helpers: dates, relative times, plurals. Locale follows the browser.

const LOCALE = typeof navigator !== 'undefined' ? navigator.language : 'en';

function toDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    // Plain dates from the registry are calendar dates, not instants.
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "28 Sept 2026" (locale-aware). */
export function formatDate(value, opts = { day: 'numeric', month: 'short', year: 'numeric' }) {
  const d = toDate(value);
  if (!d) return '';
  try {
    return new Intl.DateTimeFormat(LOCALE, opts).format(d);
  } catch {
    return d.toDateString();
  }
}

/** "Sept 2026" for YYYY-MM, "2026" for YYYY. */
export function formatPartialDate(value) {
  if (!value) return '';
  if (/^\d{4}$/.test(value)) return value;
  if (/^\d{4}-\d{2}$/.test(value)) {
    const [y, m] = value.split('-').map(Number);
    return formatDate(new Date(y, m - 1, 1), { month: 'short', year: 'numeric' });
  }
  return formatDate(value);
}

/** "just now", "5 min ago", "yesterday", "3 days ago", then a date. */
export function relativeTime(value, now = Date.now()) {
  const d = toDate(value);
  if (!d) return '';
  const diffSec = Math.round((d.getTime() - now) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 45) return 'just now';
  let rtf;
  try {
    rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto', style: 'short' });
  } catch {
    return formatDate(d);
  }
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour');
  if (abs < 86400 * 7) return rtf.format(Math.round(diffSec / 86400), 'day');
  if (abs < 86400 * 30) return rtf.format(Math.round(diffSec / (86400 * 7)), 'week');
  return formatDate(d);
}

/** plural(3, 'service') → "3 services"; plural(1, 'person', 'people') → "1 person". */
export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Oxford-less natural list: ["a","b","c"] → "a, b and c". */
export function listJoin(items, conj = 'and') {
  try {
    return new Intl.ListFormat(LOCALE, { style: 'long', type: conj === 'or' ? 'disjunction' : 'conjunction' }).format(items);
  } catch {
    if (items.length <= 1) return items.join('');
    return `${items.slice(0, -1).join(', ')} ${conj} ${items[items.length - 1]}`;
  }
}

/** Hostname for display ("chatgpt.com"), or the input if it isn't a URL. */
export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return String(url ?? '');
  }
}

/** Human form of a match pattern: "https://*.example.com/*" → "*.example.com". */
export function describeOrigin(pattern) {
  const m = /^[a-z*]+:\/\/([^/]+)\//i.exec(pattern);
  return m ? m[1] : pattern;
}

/** Date stamp for file names: 2026-09-28. */
export function fileStamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
