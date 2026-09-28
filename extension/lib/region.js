// Region helpers. Regions decide which opt-outs apply and which legal
// template a request letter uses. The user always confirms their region;
// guessRegion() only pre-selects a sensible default from the time zone.

export const REGIONS = Object.freeze([
  { code: 'EU', label: 'European Union / EEA', law: 'GDPR' },
  { code: 'UK', label: 'United Kingdom', law: 'UK GDPR' },
  { code: 'CH', label: 'Switzerland', law: 'FADP' },
  { code: 'US-CA', label: 'United States: California', law: 'CCPA/CPRA' },
  { code: 'US', label: 'United States: other states', law: 'State privacy laws' },
  { code: 'CA', label: 'Canada', law: 'PIPEDA' },
  { code: 'AU', label: 'Australia', law: 'Privacy Act 1988' },
  { code: 'BR', label: 'Brazil', law: 'LGPD' },
  { code: 'IN', label: 'India', law: 'DPDP Act' },
  { code: 'JP', label: 'Japan', law: 'APPI' },
  { code: 'OTHER', label: 'Somewhere else', law: null },
]);

const REGION_CODES = new Set(REGIONS.map((r) => r.code));

export function isRegionCode(code) {
  return REGION_CODES.has(code);
}

export function regionLabel(code) {
  return REGIONS.find((r) => r.code === code)?.label ?? 'Somewhere else';
}

/**
 * Does an opt-out whose `regions` list is `optOutRegions` apply to `userRegion`?
 * 'ALL' applies everywhere. California residents also get anything marked 'US'.
 * @param {string[]} optOutRegions
 * @param {string} userRegion
 */
export function appliesToRegion(optOutRegions, userRegion) {
  if (!Array.isArray(optOutRegions) || optOutRegions.length === 0) return false;
  if (optOutRegions.includes('ALL')) return true;
  if (optOutRegions.includes(userRegion)) return true;
  if (userRegion === 'US-CA' && optOutRegions.includes('US')) return true;
  return false;
}

/** GDPR-style regions where a formal objection to processing is a legal right. */
export function hasObjectionRight(userRegion) {
  return userRegion === 'EU' || userRegion === 'UK' || userRegion === 'CH';
}

const EU_TZ_EXCLUDE = new Set([
  'Europe/London',
  'Europe/Belfast',
  'Europe/Guernsey',
  'Europe/Isle_of_Man',
  'Europe/Jersey',
  'Europe/Zurich',
  'Europe/Moscow',
  'Europe/Kirov',
  'Europe/Volgograd',
  'Europe/Samara',
  'Europe/Saratov',
  'Europe/Ulyanovsk',
  'Europe/Astrakhan',
  'Europe/Istanbul',
  'Europe/Kiev',
  'Europe/Kyiv',
  'Europe/Minsk',
  'Europe/Simferopol',
  'Europe/Chisinau',
  'Europe/Belgrade',
  'Europe/Sarajevo',
  'Europe/Skopje',
  'Europe/Podgorica',
  'Europe/Tirane',
]);

const CA_TZ = new Set([
  'America/Toronto',
  'America/Vancouver',
  'America/Edmonton',
  'America/Winnipeg',
  'America/Halifax',
  'America/St_Johns',
  'America/Regina',
  'America/Moncton',
  'America/Whitehorse',
  'America/Yellowknife',
  'America/Iqaluit',
  'America/Glace_Bay',
  'America/Goose_Bay',
  'America/Dawson',
  'America/Dawson_Creek',
  'America/Fort_Nelson',
  'America/Creston',
  'America/Swift_Current',
  'America/Rankin_Inlet',
  'America/Resolute',
  'America/Cambridge_Bay',
  'America/Inuvik',
  'America/Atikokan',
  'America/Nipigon',
  'America/Thunder_Bay',
  'America/Rainy_River',
  'America/Pangnirtung',
]);

const US_TZ_PREFIXES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Anchorage',
  'America/Detroit',
  'America/Boise',
  'America/Indiana/',
  'America/Kentucky/',
  'America/North_Dakota/',
  'America/Menominee',
  'America/Juneau',
  'America/Sitka',
  'America/Nome',
  'America/Yakutat',
  'America/Metlakatla',
  'America/Adak',
  'Pacific/Honolulu',
];

/**
 * Best-effort default region from an IANA time zone. Always shown to the
 * user for confirmation; never used silently for anything legal.
 * @param {string} [timeZone]
 */
export function guessRegion(timeZone) {
  const tz = timeZone ?? safeTimeZone();
  if (!tz) return 'OTHER';
  if (tz === 'Europe/London' || tz === 'Europe/Belfast' || tz === 'Europe/Guernsey' || tz === 'Europe/Isle_of_Man' || tz === 'Europe/Jersey') return 'UK';
  if (tz === 'Europe/Zurich') return 'CH';
  if (tz.startsWith('Europe/') && !EU_TZ_EXCLUDE.has(tz)) return 'EU';
  if (tz === 'Atlantic/Reykjavik' || tz === 'Atlantic/Canary' || tz === 'Atlantic/Madeira' || tz === 'Atlantic/Azores') return 'EU';
  if (tz === 'America/Los_Angeles') return 'US-CA';
  if (US_TZ_PREFIXES.some((p) => tz === p || (p.endsWith('/') && tz.startsWith(p)))) return 'US';
  if (CA_TZ.has(tz)) return 'CA';
  if (tz.startsWith('Australia/')) return 'AU';
  if (tz === 'America/Sao_Paulo' || tz === 'America/Bahia' || tz === 'America/Fortaleza' || tz === 'America/Recife' || tz === 'America/Manaus' || tz === 'America/Belem' || tz === 'America/Cuiaba' || tz === 'America/Campo_Grande' || tz === 'America/Porto_Velho' || tz === 'America/Rio_Branco' || tz === 'America/Maceio' || tz === 'America/Araguaina' || tz === 'America/Boa_Vista' || tz === 'America/Santarem' || tz === 'America/Noronha' || tz === 'America/Eirunepe') return 'BR';
  if (tz === 'Asia/Kolkata' || tz === 'Asia/Calcutta') return 'IN';
  if (tz === 'Asia/Tokyo') return 'JP';
  return 'OTHER';
}

function safeTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}
