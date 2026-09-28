// Plain-language labels for registry enums and stored states. Keep copy
// short, human and honest; the UI never shows raw enum values.

export const CATEGORY_LABELS = Object.freeze({
  'ai-assistant': 'AI assistants',
  social: 'Social media',
  professional: 'Work & careers',
  productivity: 'Productivity',
  communication: 'Messaging & email',
  creative: 'Creative tools',
  developer: 'Developer tools',
  'search-browser': 'Search & browsers',
  shopping: 'Shopping',
  other: 'Other',
});

export const CATEGORY_ORDER = Object.freeze(Object.keys(CATEGORY_LABELS));

export function categoryLabel(c) {
  return CATEGORY_LABELS[c] ?? 'Other';
}

export const DATA_TYPE_LABELS = Object.freeze({
  chats: 'Chats',
  files: 'Uploaded files',
  voice: 'Voice',
  images: 'Images',
  video: 'Video',
  posts: 'Posts',
  comments: 'Comments',
  messages: 'Messages',
  code: 'Code',
  documents: 'Documents',
  profile: 'Profile info',
  activity: 'Activity',
  feedback: 'Feedback',
  'creative-works': 'Creative work',
});

export function dataTypeLabel(t) {
  return DATA_TYPE_LABELS[t] ?? String(t);
}

/** trainsOnUserData → { label, tone, long } */
export const TRAINS_LABELS = Object.freeze({
  yes: { label: 'Yes', tone: 'bad', long: 'Uses your data to train AI' },
  conditional: { label: 'In some cases', tone: 'warn', long: 'Uses some data to train AI' },
  no: { label: 'No', tone: 'good', long: 'Says it doesn’t train on your data' },
  unknown: { label: 'Unclear', tone: 'neutral', long: 'Not clear whether it trains on your data' },
});

/** defaultState → { label, tone, long } */
export const DEFAULT_LABELS = Object.freeze({
  opted_in: { label: 'On by default', tone: 'bad', long: 'Training is on unless you opt out' },
  opted_out: { label: 'Off by default', tone: 'good', long: 'Training is off unless you opt in' },
  no_choice: { label: 'No choice offered', tone: 'warn', long: 'There’s no setting to turn it off' },
  varies_by_region: { label: 'Depends on region', tone: 'warn', long: 'The default depends on where you live' },
  not_applicable: { label: 'Not applicable', tone: 'neutral', long: 'There’s nothing to switch off' },
});

export const EFFORT_LABELS = Object.freeze({
  quick: { label: 'Quick', long: 'About a minute' },
  moderate: { label: 'A few minutes', long: 'A few minutes' },
  involved: { label: 'Takes a while', long: 'Takes a while, may need follow-up' },
});

export const CONFIDENCE_LABELS = Object.freeze({
  high: { label: 'Reliable', tone: 'good', hint: 'Tested and usually works first time.' },
  medium: { label: 'Usually works', tone: 'info', hint: 'Works most of the time. If the site has changed, NoTrain switches to step-by-step guidance.' },
  experimental: { label: 'Experimental', tone: 'warn', hint: 'New or fragile. Watch it run and check the result.' },
});

export const OPT_OUT_TYPE_LABELS = Object.freeze({
  toggle: 'Account setting',
  form: 'Online form',
  email: 'Email request',
  'account-deletion': 'Delete your account',
  none: 'No opt-out',
});

export const OPT_OUT_STATUS_LABELS = Object.freeze({
  not_started: { label: 'Not done yet', tone: 'neutral' },
  done: { label: 'Done', tone: 'good' },
  sent: { label: 'Request sent', tone: 'good' },
  skipped: { label: 'Skipped', tone: 'neutral' },
  needs_attention: { label: 'Needs attention', tone: 'bad' },
});

export const METHOD_LABELS = Object.freeze({
  auto: 'automatically',
  guided: 'with guidance',
  manual: 'marked by you',
  letter: 'by letter',
});

/** Messages for an engine outcome stored in lastOutcome. */
export const OUTCOME_MESSAGES = Object.freeze({
  success: 'Done. The setting is off.',
  already: 'The setting was already off.',
  not_found: 'NoTrain couldn’t find the setting. The page may have changed, so follow the steps instead.',
  needs_login: 'You weren’t signed in. Sign in, then try again.',
  failed: 'Something went wrong on the page. Follow the steps instead.',
  cancelled: 'You stopped the run.',
  mismatch: 'The setting was turned back on.',
});

export const ALERT_KIND_LABELS = Object.freeze({
  policy_change: { label: 'Policy change', icon: 'letter' },
  flip_back: { label: 'Setting changed', icon: 'refresh' },
  reminder: { label: 'Reminder', icon: 'clock' },
  new_service: { label: 'New in NoTrain', icon: 'sparkles' },
});

export const LETTER_KINDS = Object.freeze([
  {
    id: 'objection',
    label: 'Object to AI training',
    desc: 'Ask the company to stop using your data to train AI.',
    regions: ['EU', 'UK', 'CH'],
  },
  {
    id: 'ccpa-opt-out',
    label: 'Opt out of sale, sharing and sensitive use',
    desc: 'California rights under the CCPA/CPRA.',
    regions: ['US-CA'],
  },
  {
    id: 'erasure',
    label: 'Delete my data',
    desc: 'Ask for your personal data to be deleted.',
    regions: ['EU', 'UK', 'CH', 'US-CA', 'US', 'CA', 'AU', 'BR', 'IN', 'JP', 'OTHER'],
  },
  {
    id: 'access',
    label: 'Tell me what you hold',
    desc: 'Ask what data they have and how it’s used for AI.',
    regions: ['EU', 'UK', 'CH', 'US-CA', 'US', 'CA', 'AU', 'BR', 'IN', 'JP', 'OTHER'],
  },
  {
    id: 'generic',
    label: 'Polite request not to train',
    desc: 'Works anywhere. No specific law cited.',
    regions: ['EU', 'UK', 'CH', 'US-CA', 'US', 'CA', 'AU', 'BR', 'IN', 'JP', 'OTHER'],
  },
]);

/** The letter kind that makes most sense for a region. */
export function recommendedLetterKind(region) {
  if (region === 'EU' || region === 'UK' || region === 'CH') return 'objection';
  if (region === 'US-CA') return 'ccpa-opt-out';
  return 'generic';
}

export const REMINDER_OPTIONS = Object.freeze([
  { days: 30, label: 'Every month' },
  { days: 90, label: 'Every 3 months' },
  { days: 180, label: 'Every 6 months' },
  { days: 365, label: 'Once a year' },
]);
