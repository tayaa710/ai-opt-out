// Request-letter generator. Pure ES module: no chrome.* APIs, no DOM, no network.
//
//   generateLetter({ service, optOut?, region, kind, profile?, date? })
//     → { kind, region, subject, body, to, mailto?, formUrl, legalBasis, citations,
//         responseDeadline, authority }
//
// Letters are polite, cite the provisions that actually apply in the user's region, ask for
// written confirmation, and never claim more than the law gives. Where a law gives no specific
// right (for example, there is no general right to object to AI training under the CCPA), the
// letter says so and makes a request instead. The UI shows a "this is not legal advice" note;
// the letter itself does not.
//
// Every region's text was written against the primary legislation (GDPR, UK GDPR, the Swiss
// FADP, the CCPA as amended by the CPRA and its regulations, PIPEDA, the Australian Privacy
// Principles, the LGPD, India's DPDP Act 2023 and Japan's APPI). Keep citations conservative:
// cite an article only when the letter's claim follows from its text.

import { REGIONS } from './region.js';

const ALL_REGIONS = Object.freeze(REGIONS.map((r) => r.code));

/** Missing profile fields are replaced with these placeholders so the user notices them. */
export const PLACEHOLDERS = Object.freeze({
  fullName: '[Your full name]',
  email: '[Your email address]',
  accountEmail: '[The email address or username on your account]',
  state: '[Your state of residence]',
});

/**
 * Letter kinds. `regions` lists where the kind is offered; `availableKinds(region)` returns
 * them in recommended order with region-specific labels.
 */
export const LETTER_KINDS = Object.freeze([
  Object.freeze({
    id: 'objection',
    label: 'Object to AI training',
    description: 'Formally object to, or withdraw consent for, the use of your data to train AI models.',
    regions: Object.freeze(['EU', 'UK', 'CH', 'CA', 'AU', 'BR', 'IN', 'JP']),
  }),
  Object.freeze({
    id: 'ccpa-opt-out',
    label: 'Opt out of sale and sharing',
    description:
      'Use your California rights to stop the sale and sharing of your data and limit use of sensitive data, and ask them not to train AI on it.',
    regions: Object.freeze(['US-CA']),
  }),
  Object.freeze({
    id: 'generic',
    label: 'Ask them to stop training on my data',
    description: 'A plain, polite request that works in any country, without relying on a specific law.',
    regions: ALL_REGIONS,
  }),
  Object.freeze({
    id: 'erasure',
    label: 'Delete my data used for AI training',
    description:
      'Ask the company to delete the personal data it holds for AI training, without closing your account.',
    regions: ALL_REGIONS,
  }),
  Object.freeze({
    id: 'access',
    label: 'Ask what they hold and how it is used',
    description:
      'Find out what personal data the company holds about you and whether it is used to train AI.',
    regions: ALL_REGIONS,
  }),
]);

const KIND_IDS = new Set(LETTER_KINDS.map((k) => k.id));

const REGION_LABEL_OVERRIDES = {
  CA: { objection: 'Withdraw consent to AI training' },
  IN: { objection: 'Withdraw consent to AI training' },
  AU: { objection: 'Ask them not to use my data for AI training' },
  JP: { objection: 'Ask them to stop using my data for AI training' },
  BR: { objection: 'Oppose AI training on my data' },
};

/**
 * Letter kinds offered for a region, most useful first, with region-specific labels.
 * @param {string} region region code from lib/region.js
 * @returns {{ id: string, label: string, description: string }[]}
 */
export function availableKinds(region) {
  const code = ALL_REGIONS.includes(region) ? region : 'OTHER';
  return LETTER_KINDS.filter((k) => k.regions.includes(code)).map((k) => ({
    id: k.id,
    label: REGION_LABEL_OVERRIDES[code]?.[k.id] ?? k.label,
    description: k.description,
  }));
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * Format a date for a letter: "September 28, 2026" in the US, "28 September 2026" elsewhere.
 * Accepts a Date, an ISO string or YYYY-MM-DD (taken as a calendar date, no time zone shift).
 */
export function formatLetterDate(date, region) {
  let y;
  let m;
  let d;
  const ymd = typeof date === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
  if (ymd) {
    [y, m, d] = [Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])];
  } else {
    const dt = date instanceof Date ? date : date ? new Date(date) : new Date();
    const valid = Number.isNaN(dt.getTime()) ? new Date() : dt;
    [y, m, d] = [valid.getFullYear(), valid.getMonth(), valid.getDate()];
  }
  return region === 'US' || region === 'US-CA' ? `${MONTHS[m]} ${d}, ${y}` : `${d} ${MONTHS[m]} ${y}`;
}

const DATA_TYPE_PHRASES = {
  chats: 'conversations',
  files: 'uploaded files',
  voice: 'voice recordings',
  images: 'images',
  video: 'videos',
  posts: 'posts',
  comments: 'comments',
  messages: 'messages',
  code: 'code',
  documents: 'documents',
  profile: 'profile information',
  activity: 'activity on the service',
  feedback: 'feedback',
  'creative-works': 'creative work',
};

function joinList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** "my conversations, uploaded files and images" */
export function describeData(service) {
  const phrases = (service?.training?.dataTypes ?? []).map((t) => DATA_TYPE_PHRASES[t]).filter(Boolean);
  return phrases.length ? `my ${joinList(phrases)}` : 'my content and account data';
}

/** Collapse whitespace and strip line breaks from user-supplied single-line values. */
function oneLine(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function encodeMailbox(email) {
  const at = email.lastIndexOf('@');
  if (at < 1) return encodeURIComponent(email);
  return `${encodeURIComponent(email.slice(0, at))}@${encodeURIComponent(email.slice(at + 1))}`;
}

/**
 * RFC 6068 mailto URL. Line breaks in the body are sent as CRLF, as the RFC requires.
 */
export function buildMailto(to, subject, body) {
  const q = (s) => encodeURIComponent(s.replace(/\r?\n/g, '\r\n'));
  return `mailto:${encodeMailbox(to)}?subject=${q(subject)}&body=${q(body)}`;
}

const EMAIL_RE = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]+$/;

// ---------------------------------------------------------------------------
// Region profiles: laws, deadlines, authorities
// ---------------------------------------------------------------------------

const AUTHORITIES = {
  EU: {
    name: 'your national data protection authority (list at edpb.europa.eu)',
    url: 'https://www.edpb.europa.eu/about-edpb/about-edpb/members_en',
  },
  UK: { name: "the Information Commissioner's Office (ICO)", url: 'https://ico.org.uk/make-a-complaint/' },
  CH: {
    name: 'the Federal Data Protection and Information Commissioner (FDPIC)',
    url: 'https://www.edoeb.admin.ch/',
  },
  'US-CA': { name: 'the California Privacy Protection Agency', url: 'https://cppa.ca.gov/' },
  US: { name: "your state Attorney General's office", url: null },
  CA: { name: 'the Office of the Privacy Commissioner of Canada', url: 'https://www.priv.gc.ca/' },
  AU: {
    name: 'the Office of the Australian Information Commissioner (OAIC)',
    url: 'https://www.oaic.gov.au/privacy/privacy-complaints',
  },
  BR: { name: 'the National Data Protection Authority (ANPD)', url: 'https://www.gov.br/anpd/' },
  IN: { name: 'the Data Protection Board of India', url: null },
  JP: { name: 'the Personal Information Protection Commission (PPC)', url: 'https://www.ppc.go.jp/en/' },
  OTHER: { name: null, url: null },
};

/** First mention (defines the term); later mentions say "AI training". */
const AI_USE_DEF =
  'developing, training, fine-tuning or otherwise improving artificial intelligence (AI) models (“AI training”)';
const AI_USE = 'AI training';

/** How the generic letter refers to the region's law, if any. */
const GENERIC_LAW_NAMES = {
  EU: 'the GDPR',
  UK: 'the UK GDPR',
  CH: 'the Swiss Federal Act on Data Protection',
  'US-CA': 'the California Consumer Privacy Act',
  US: 'a state consumer privacy law',
  CA: 'PIPEDA',
  AU: 'the Privacy Act 1988',
  BR: 'the LGPD',
  IN: 'the Digital Personal Data Protection Act, 2023',
  JP: 'the Act on the Protection of Personal Information',
};

// ---------------------------------------------------------------------------
// Letter assembly
// ---------------------------------------------------------------------------

/**
 * Shared context for the templates.
 */
function context({ service, optOut, region, profile, date }) {
  const name = oneLine(profile?.fullName) || PLACEHOLDERS.fullName;
  const rawEmail = oneLine(profile?.email);
  const email = rawEmail || PLACEHOLDERS.email;
  const svc = oneLine(service?.name) || '[Service name]';
  const co = oneLine(service?.company) || svc;
  const contacts = service?.contacts ?? {};
  const gdprLike = region === 'EU' || region === 'UK' || region === 'CH';
  // Under GDPR-style laws the DPO is the natural addressee; elsewhere the privacy team.
  const candidates = gdprLike
    ? [contacts.dpoEmail, contacts.privacyEmail]
    : [contacts.privacyEmail, contacts.dpoEmail];
  const to = candidates.find((e) => typeof e === 'string' && EMAIL_RE.test(e.trim()))?.trim() ?? null;
  const toDpo = Boolean(to && to === contacts.dpoEmail && (region === 'EU' || region === 'UK'));
  return {
    service,
    optOut,
    region,
    name,
    email,
    accountEmail: rawEmail || PLACEHOLDERS.accountEmail,
    svc,
    co,
    data: describeData(service),
    trains: service?.training?.trainsOnUserData ?? 'unknown',
    dateText: formatLetterDate(date, region),
    to,
    toDpo,
    formUrl: typeof contacts.privacyRequestUrl === 'string' ? contacts.privacyRequestUrl : null,
    postalAddress: typeof contacts.postalAddress === 'string' ? oneLine(contacts.postalAddress) : null,
  };
}

/** Opening paragraph: what the service does (without overstating it), then why I am writing. */
function introParagraph(c, purpose) {
  const src = `personal data from ${c.svc}, such as ${c.data}`;
  let fact;
  switch (c.trains) {
    case 'yes':
      fact = `According to your published documentation, ${c.co} uses ${src}, to develop and train AI models.`;
      break;
    case 'conditional':
      fact = `According to your published documentation, ${c.co} may in some circumstances use ${src}, to develop and train AI models.`;
      break;
    case 'no':
      fact = `Your published documentation states that ${c.co} does not use personal data from ${c.svc} to train AI models. I would be grateful for written confirmation of this, and for this letter to be kept on record in case that changes.`;
      break;
    default:
      fact = `It is not clear from your published documentation whether ${c.co} uses ${src}, to develop or train AI models.`;
  }
  return `I am a user of ${c.svc}. ${fact} ${purpose}`;
}

/** Default "particular situation" statement for GDPR Art. 21(1) objections. The user may edit it. */
function particularSituation(c) {
  return `My ${c.svc} account contains personal information about me, and about people I communicate with, that I provided in order to use the service. I did not provide it so that it could be built into AI models over which I have no visibility or control, and from which it cannot realistically be corrected or removed.`;
}

/** Sentence acknowledging an in-product setting, if the letter was started from one. */
function settingNote(c) {
  const o = c.optOut;
  if (!o || (o.type !== 'toggle' && o.type !== 'form')) return null;
  const title = oneLine(o.title);
  if (!title) return null;
  return `I am aware that ${c.svc} offers this option: ${title.replace(/[.\s]+$/, '')}. Please treat this letter as a separate, formal request that applies to all personal data about me that you hold, whether or not that option is used, and please act on it directly rather than asking me to resubmit it through another channel.`;
}

function numbered(items) {
  return items.map((item, i) => `${i + 1}. ${item}`).join('\n');
}

function identityBlock(c, extra = []) {
  return [
    'My details:',
    `Name: ${c.name}`,
    `Email address on my ${c.svc} account: ${c.accountEmail}`,
    ...extra,
  ].join('\n');
}

function signOff(c) {
  return ['Thank you for your help.', '', 'Kind regards,', '', c.name, c.email].join('\n');
}

function header(c) {
  const recipient = c.toDpo ? `Data Protection Officer, ${c.co}` : `Privacy team, ${c.co}`;
  const lines = [c.dateText, '', `To: ${recipient}`];
  if (c.to) lines.push(c.to);
  else if (c.postalAddress) lines.push(c.postalAddress);
  return lines.join('\n');
}

function greeting(c) {
  return c.toDpo ? 'Dear Data Protection Officer,' : 'Dear Privacy Team,';
}

function assemble(c, paragraphs) {
  return [header(c), greeting(c), ...paragraphs.filter(Boolean), signOff(c)].join('\n\n');
}

const CONFIRM_TRAINING = (c) => [
  `whether personal data about me has already been included in datasets used to train AI models and, if so, that it will be excluded from future training;`,
  `which products, services and companies in your group this applies to, including any third party to whom you have disclosed my personal data for ${AI_USE};`,
  c.trains === 'no'
    ? 'that you do not use my personal data for these purposes, and that you will tell me before this changes.'
    : 'the date from which my personal data will no longer be used for these purposes.',
];

const MODEL_CAVEAT =
  'I understand that removing information from a model that has already been trained may be difficult. If you cannot do so, please explain what you can do instead, for example excluding my data from all future training and preventing models from reproducing it.';

// ---------------------------------------------------------------------------
// Templates: kind → region → builder
// ---------------------------------------------------------------------------

function gdprVariant(region) {
  const uk = region === 'UK';
  const law = uk ? 'UK GDPR' : 'GDPR';
  const art = (a) => `Article ${a} ${law}`;
  const deadline = uk
    ? 'The UK GDPR requires you to respond without undue delay and in any event within one month of receiving this letter. If you need to extend that period, please tell me within the first month and explain why.'
    : `Please respond without undue delay and in any event within one month of receiving this letter, as ${art('12(3)')} requires. If you need to extend that period, ${art('12(3)')} requires you to tell me within the first month and explain why.`;
  const escalation = uk
    ? `If I am not satisfied with your response, I may complain to you and then to the Information Commissioner's Office (https://ico.org.uk/make-a-complaint/).`
    : `If I am not satisfied with your response, I may lodge a complaint with a data protection supervisory authority (${art('77')}).`;
  const identity = `If you have reasonable doubts about my identity, you may ask for the additional information necessary to confirm it${uk ? '' : ` (${art('12(6)')})`}, but please do not ask for more than that.`;
  return { law, art, deadline, escalation, identity, uk };
}

const TEMPLATES = {
  objection: {
    EU: objectionGdpr,
    UK: objectionGdpr,
    CH(c) {
      return {
        subject: `Objection to the processing of my personal data for AI training (Art. 30 FADP) – ${c.svc}`,
        legalBasis:
          'Swiss Federal Act on Data Protection (FADP): Art. 30(2)(b) (processing against the express will of the data subject), Art. 31 (justification), Art. 32(2) (legal claims)',
        citations: ['Art. 30(2)(b) FADP', 'Art. 31 FADP', 'Art. 32(2) FADP'],
        responseDeadline: '30 days (requested; the FADP sets no fixed deadline for objections)',
        body: assemble(c, [
          introParagraph(
            c,
            `I am writing to object to the processing of my personal data for ${AI_USE_DEF}.`,
          ),
          `I expressly object to ${c.co} processing my personal data for these purposes. Under Article 30(2)(b) of the Federal Act on Data Protection (FADP), processing personal data against the express will of the data subject is a breach of privacy unless it is justified under Article 31 FADP. To the extent that you rely on my consent for this processing, I withdraw it.`,
          settingNote(c),
          `Please confirm in writing:\n${numbered([
            'that you have stopped, or will stop, processing my personal data for these purposes;',
            ...CONFIRM_TRAINING(c),
          ])}\nIf you consider that this processing is justified despite my objection, please tell me on what grounds.`,
          'I would be grateful for your reply within 30 days of receiving this letter.',
          identityBlock(c),
          `I would prefer to resolve this directly with you. If that is not possible, I may contact the Federal Data Protection and Information Commissioner (FDPIC) or rely on my rights under Article 32 FADP.`,
        ]),
      };
    },
    CA(c) {
      return {
        subject: `Withdrawal of consent to the use of my personal information for AI training – ${c.svc}`,
        legalBasis:
          'Personal Information Protection and Electronic Documents Act (PIPEDA), Schedule 1, Principle 4.3.8 (withdrawal of consent)',
        citations: ['PIPEDA Sch. 1, Principle 4.3.8', 'PIPEDA s. 11 (complaints)'],
        responseDeadline: '30 days (requested)',
        body: assemble(c, [
          introParagraph(
            c,
            `I am writing to withdraw my consent to the use of my personal information for ${AI_USE_DEF}.`,
          ),
          `Under Principle 4.3.8 of Schedule 1 to the Personal Information Protection and Electronic Documents Act (PIPEDA), an individual may withdraw consent at any time, subject to legal or contractual restrictions and reasonable notice. I withdraw any consent, express or implied, that I have given to ${c.co} to use my personal information for these purposes. As Principle 4.3.8 requires, please tell me about any implications of this withdrawal.`,
          'If a provincial private-sector privacy law applies to you instead of PIPEDA (for example in Quebec, British Columbia or Alberta), please treat this letter as a request under that law.',
          settingNote(c),
          `Please confirm in writing:\n${numbered([
            'that you will no longer use my personal information for these purposes;',
            ...CONFIRM_TRAINING(c),
          ])}`,
          'I would be grateful for your reply within 30 days of receiving this letter.',
          identityBlock(c),
          'If I am not satisfied with your response, I may file a complaint with the Office of the Privacy Commissioner of Canada (https://www.priv.gc.ca/).',
        ]),
      };
    },
    AU(c) {
      return {
        subject: `Request not to use my personal information for AI training – ${c.svc}`,
        legalBasis:
          'Privacy Act 1988 (Cth), Australian Privacy Principle 6 (use or disclosure for a secondary purpose)',
        citations: ['APP 6.1', 'APP 6.2(a)'],
        responseDeadline: '30 days (requested)',
        body: assemble(c, [
          introParagraph(c, `I am writing about the use of my personal information for ${AI_USE_DEF}.`),
          `Australian Privacy Principle (APP) 6 generally prevents an organisation from using personal information for a purpose other than the one for which it was collected, unless the individual consents or an exception applies. I do not consent to ${c.co} using my personal information for these purposes, and to the extent that I have given consent, I withdraw it. I also do not reasonably expect my personal information to be used in this way (APP 6.2(a)).`,
          settingNote(c),
          `Please confirm in writing:\n${numbered([
            'that you will not use my personal information for these purposes;',
            ...CONFIRM_TRAINING(c),
          ])}`,
          'I would be grateful for your reply within 30 days of receiving this letter.',
          identityBlock(c),
          'If I do not receive a satisfactory response within 30 days, I may complain to the Office of the Australian Information Commissioner (https://www.oaic.gov.au/privacy/privacy-complaints).',
        ]),
      };
    },
    BR(c) {
      return {
        subject: `Opposition to the use of my personal data for AI training (LGPD, Art. 18) – ${c.svc}`,
        legalBasis:
          'Lei Geral de Proteção de Dados (Law 13.709/2018): Art. 18 §2 (right to oppose), Art. 18 IX and Art. 8 §5 (revocation of consent), Art. 7 IX (legitimate interest)',
        citations: [
          'LGPD Art. 18 §2',
          'LGPD Art. 18 IX',
          'LGPD Art. 8 §5',
          'LGPD Art. 7 IX',
          'LGPD Art. 18 §1',
        ],
        responseDeadline: '15 days (requested)',
        body: assemble(c, [
          introParagraph(c, `I am writing to oppose the processing of my personal data for ${AI_USE_DEF}.`),
          `To the extent that ${c.co} relies on legitimate interest (Article 7, IX of the General Data Protection Law, LGPD) for this processing, I oppose it under Article 18, §2 LGPD. I consider that my fundamental rights and freedoms prevail over that interest and that this use does not respect my legitimate expectations. To the extent that you rely on my consent, I revoke it under Article 8, §5 and Article 18, IX LGPD.`,
          settingNote(c),
          `Please confirm in writing:\n${numbered([
            'that you have stopped, or will stop, processing my personal data for these purposes;',
            ...CONFIRM_TRAINING(c),
          ])}`,
          'Under Article 18, §5 LGPD, this request must be handled free of charge. I would be grateful for your reply within 15 days of receiving this letter.',
          identityBlock(c),
          'If I am not satisfied with your response, I may petition the National Data Protection Authority (ANPD) under Article 18, §1 LGPD.',
        ]),
      };
    },
    IN(c) {
      return {
        subject: `Withdrawal of consent to the use of my personal data for AI training – ${c.svc}`,
        legalBasis:
          'Digital Personal Data Protection Act, 2023: s. 6(4) (withdrawal of consent), s. 6(6) (cease processing), s. 13 (grievance redressal). The Act is being brought into force in phases.',
        citations: ['DPDP Act 2023 s. 6(4)', 'DPDP Act 2023 s. 6(6)', 'DPDP Act 2023 s. 13'],
        responseDeadline: 'Within a reasonable time (s. 6(6)); 30 days requested',
        body: assemble(c, [
          introParagraph(
            c,
            `I am writing to withdraw my consent to the use of my personal data for ${AI_USE_DEF}.`,
          ),
          `I withdraw any consent that I have given to ${c.co} to process my personal data for these purposes. Section 6(4) of the Digital Personal Data Protection Act, 2023 gives a Data Principal the right to withdraw consent at any time, and section 6(6) requires a Data Fiduciary to stop processing, and to cause its Data Processors to stop processing, within a reasonable time after consent is withdrawn. If these provisions are not yet in force for your organisation, I ask you to honour this request now in the same way.`,
          settingNote(c),
          `Please confirm in writing:\n${numbered([
            'that you, and any Data Processor acting for you, will no longer process my personal data for these purposes;',
            ...CONFIRM_TRAINING(c),
          ])}`,
          'I would be grateful for your reply within 30 days of receiving this letter. If I need to use your grievance redressal mechanism (section 13), please tell me how.',
          identityBlock(c),
        ]),
      };
    },
    JP(c) {
      return {
        subject: `Request to stop using my personal data for AI training (APPI Art. 35) – ${c.svc}`,
        legalBasis:
          'Act on the Protection of Personal Information (APPI): Art. 18 (restriction by purpose of use), Art. 35 (cessation of use)',
        citations: ['APPI Art. 18', 'APPI Art. 35(1)', 'APPI Art. 35(5)'],
        responseDeadline: 'Without delay (APPI); 30 days requested',
        body: assemble(c, [
          introParagraph(c, `I am writing to ask you to stop using my personal data for ${AI_USE_DEF}.`),
          `Under Article 18 of the Act on the Protection of Personal Information (APPI), a business may not handle personal information beyond the scope necessary to achieve the purpose of use it has specified without the principal's prior consent. I do not consent to my personal data being used for these purposes. If this use goes beyond the purpose of use that you have specified, I request under Article 35(1) APPI that you cease using my retained personal data for it. I also request that you cease this use under Article 35(5) APPI, because I consider that it is likely to harm my rights or legitimate interests.`,
          settingNote(c),
          `Please confirm in writing:\n${numbered([
            'whether you will cease using my retained personal data for these purposes, and if not, why not;',
            ...CONFIRM_TRAINING(c),
          ])}`,
          'The APPI requires you to notify me without delay of whether you will stop this use. I would be grateful for your reply within 30 days of receiving this letter.',
          identityBlock(c),
          'If I am not satisfied with your response, I may consult the Personal Information Protection Commission (PPC).',
        ]),
      };
    },
  },

  erasure: {
    EU: erasureGdpr,
    UK: erasureGdpr,
    CH(c) {
      return {
        subject: `Request to delete my personal data used for AI training (FADP) – ${c.svc}`,
        legalBasis:
          'Swiss FADP: Art. 30(2)(b) (processing against the express will of the data subject), Art. 6(4) (destruction or anonymisation), Art. 32(2)(c) (deletion)',
        citations: ['Art. 30(2)(b) FADP', 'Art. 6(4) FADP', 'Art. 32(2)(c) FADP'],
        responseDeadline: '30 days (requested)',
        body: assemble(c, [
          introParagraph(
            c,
            `I am writing to ask you to delete personal data about me that you hold for ${AI_USE_DEF}.`,
          ),
          `I expressly object to ${c.co} processing my personal data for these purposes (Article 30(2)(b) FADP), and I ask you to delete or anonymise the personal data about me that you hold for them, including copies in datasets used to train, fine-tune or evaluate AI models. Under Article 6(4) FADP, personal data must be destroyed or anonymised as soon as it is no longer required for the purpose of processing, and Article 32(2)(c) FADP allows a data subject to request deletion.`,
          `This request does not ask you to close my ${c.svc} account or to delete data you need to provide the service to me.`,
          `Please confirm in writing:\n${numbered([
            'that you have deleted or anonymised this data, and when;',
            'whether this data has already been used to train AI models that you use or make available, and what you have done about it;',
            'that my personal data will not be used for these purposes in future.',
          ])}`,
          MODEL_CAVEAT,
          'I would be grateful for your reply within 30 days of receiving this letter.',
          identityBlock(c),
          'If necessary, I may contact the Federal Data Protection and Information Commissioner (FDPIC).',
        ]),
      };
    },
    'US-CA'(c) {
      return {
        subject: `Request to delete my personal information used for AI training (CCPA) – ${c.svc}`,
        legalBasis:
          'California Consumer Privacy Act as amended by the CPRA: Cal. Civ. Code § 1798.105 (right to delete), § 1798.130 (45-day response), § 1798.125 (non-discrimination)',
        citations: ['Cal. Civ. Code § 1798.105', 'Cal. Civ. Code § 1798.130', 'Cal. Civ. Code § 1798.125'],
        responseDeadline: '45 calendar days, extendable once by 45 days with notice (§ 1798.130)',
        body: assemble(c, [
          introParagraph(
            c,
            `I am a California resident and I am writing to request deletion of personal information under the California Consumer Privacy Act (CCPA).`,
          ),
          `Under Cal. Civ. Code § 1798.105, I request that you delete the personal information about me that you have collected and hold for ${AI_USE_DEF}, including copies in datasets used to train, fine-tune or evaluate AI models. Please also notify your service providers and contractors to delete it, and notify any third parties to whom you have sold or shared it, as § 1798.105 requires. If you rely on an exception to decline any part of this request, please tell me which exception and why.`,
          `This request is limited to that information. It does not ask you to close my ${c.svc} account.`,
          `Please confirm in writing:\n${numbered([
            'that you have deleted this information, and when;',
            'whether this information has already been used to train AI models that you use or make available, and what you have done about it;',
            'that my personal information will not be used for these purposes in future.',
          ])}`,
          MODEL_CAVEAT,
          'Cal. Civ. Code § 1798.130 requires you to respond within 45 calendar days of receiving this request. That period may be extended once by a further 45 days when reasonably necessary, if you tell me within the first 45 days. You may not discriminate against me for making this request (§ 1798.125).',
          identityBlock(c),
          'If I am not satisfied with your response, I may contact the California Privacy Protection Agency (https://cppa.ca.gov/).',
        ]),
      };
    },
    US(c) {
      return {
        subject: `Request to delete my personal data used for AI training – ${c.svc}`,
        legalBasis:
          'Comprehensive state consumer privacy laws (for example in Virginia, Colorado, Connecticut, Texas and Oregon): right to delete, 45-day response, right to appeal',
        citations: ['State consumer privacy law of the consumer’s state of residence'],
        responseDeadline: '45 days under most state privacy laws (extendable once by 45 days)',
        body: assemble(c, [
          introParagraph(
            c,
            `I am writing to ask you to delete personal data about me that you hold for ${AI_USE_DEF}.`,
          ),
          `I live in ${PLACEHOLDERS.state}. If a consumer privacy law applies in my state, please treat this letter as a request to delete personal data under that law. In any case, I ask you to delete the personal data about me that you hold for these purposes, including copies in datasets used to train, fine-tune or evaluate AI models, and to ask any processors or third parties who received it for these purposes to do the same.`,
          `This request is limited to that data. It does not ask you to close my ${c.svc} account.`,
          `Please confirm in writing:\n${numbered([
            'that you have deleted this data, and when;',
            'whether this data has already been used to train AI models that you use or make available, and what you have done about it;',
            'that my personal data will not be used for these purposes in future.',
          ])}`,
          MODEL_CAVEAT,
          'State privacy laws such as those of Virginia, Colorado, Connecticut, Texas and Oregon generally require a response within 45 days, which may be extended once by 45 days. If you decline any part of this request, please explain why and tell me how to appeal your decision.',
          identityBlock(c),
        ]),
      };
    },
    CA(c) {
      return {
        subject: `Request to delete my personal information used for AI training – ${c.svc}`,
        legalBasis:
          'PIPEDA, Schedule 1: Principle 4.3.8 (withdrawal of consent), Principle 4.5.3 (destroy, erase or anonymize information no longer required)',
        citations: ['PIPEDA Sch. 1, Principle 4.3.8', 'PIPEDA Sch. 1, Principle 4.5.3'],
        responseDeadline: '30 days (requested)',
        body: assemble(c, [
          introParagraph(
            c,
            `I am writing to ask you to delete personal information about me that you hold for ${AI_USE_DEF}.`,
          ),
          `I withdraw any consent I have given to ${c.co} to use my personal information for these purposes (PIPEDA, Schedule 1, Principle 4.3.8). As a result, personal information held only for these purposes is no longer required and, under Principle 4.5.3, should be destroyed, erased or made anonymous. I ask you to do so, including for copies in datasets used to train, fine-tune or evaluate AI models.`,
          `This request does not ask you to close my ${c.svc} account.`,
          `Please confirm in writing:\n${numbered([
            'that you have deleted or anonymized this information, and when;',
            'whether this information has already been used to train AI models that you use or make available, and what you have done about it;',
            'that my personal information will not be used for these purposes in future.',
          ])}`,
          MODEL_CAVEAT,
          'I would be grateful for your reply within 30 days of receiving this letter.',
          identityBlock(c),
          'If I am not satisfied with your response, I may file a complaint with the Office of the Privacy Commissioner of Canada (https://www.priv.gc.ca/).',
        ]),
      };
    },
    AU(c) {
      return {
        subject: `Request to delete my personal information used for AI training – ${c.svc}`,
        legalBasis:
          'Privacy Act 1988 (Cth): APP 6 (secondary purposes), APP 11.2 (destroy or de-identify information no longer needed)',
        citations: ['APP 6', 'APP 11.2'],
        responseDeadline: '30 days (requested)',
        body: assemble(c, [
          introParagraph(
            c,
            `I am writing to ask you to delete personal information about me that you hold for ${AI_USE_DEF}.`,
          ),
          `I do not consent to ${c.co} using my personal information for these purposes (Australian Privacy Principle 6), and to the extent I have given consent, I withdraw it. APP 11.2 requires an organisation to take reasonable steps to destroy or de-identify personal information that it no longer needs for any purpose for which it may be used or disclosed under the APPs. I ask you to destroy or de-identify the personal information about me that you hold for these purposes, including copies in datasets used to train, fine-tune or evaluate AI models.`,
          `This request does not ask you to close my ${c.svc} account.`,
          `Please confirm in writing:\n${numbered([
            'that you have destroyed or de-identified this information, and when;',
            'whether this information has already been used to train AI models that you use or make available, and what you have done about it;',
            'that my personal information will not be used for these purposes in future.',
          ])}`,
          MODEL_CAVEAT,
          'I would be grateful for your reply within 30 days of receiving this letter.',
          identityBlock(c),
          'If I do not receive a satisfactory response within 30 days, I may complain to the Office of the Australian Information Commissioner (https://www.oaic.gov.au/privacy/privacy-complaints).',
        ]),
      };
    },
    BR(c) {
      return {
        subject: `Request to delete my personal data used for AI training (LGPD, Art. 18) – ${c.svc}`,
        legalBasis:
          'LGPD (Law 13.709/2018): Art. 18 IV (anonymisation, blocking or elimination of unnecessary or excessive data), Art. 18 VI (elimination of data processed with consent), Art. 18 §2 (opposition)',
        citations: ['LGPD Art. 18 IV', 'LGPD Art. 18 VI', 'LGPD Art. 18 IX', 'LGPD Art. 18 §2'],
        responseDeadline: '15 days (requested)',
        body: assemble(c, [
          introParagraph(
            c,
            `I am writing to ask you to delete personal data about me that you hold for ${AI_USE_DEF}.`,
          ),
          `To the extent that you rely on my consent for this processing, I revoke it (Article 18, IX LGPD) and request the elimination of the personal data processed on that basis (Article 18, VI). To the extent that you rely on another legal basis, I oppose the processing (Article 18, §2) and request the elimination or anonymisation of personal data about me that is unnecessary or excessive for providing the service to me (Article 18, IV). This includes copies in datasets used to train, fine-tune or evaluate AI models.`,
          `This request does not ask you to close my ${c.svc} account.`,
          `Please confirm in writing:\n${numbered([
            'that you have eliminated or anonymised this data, and when;',
            'whether this data has already been used to train AI models that you use or make available, and what you have done about it;',
            'with which public and private entities you have shared this data (Article 18, VII).',
          ])}`,
          MODEL_CAVEAT,
          'Under Article 18, §5 LGPD, this request must be handled free of charge. I would be grateful for your reply within 15 days of receiving this letter.',
          identityBlock(c),
          'If I am not satisfied with your response, I may petition the National Data Protection Authority (ANPD) under Article 18, §1 LGPD.',
        ]),
      };
    },
    IN(c) {
      return {
        subject: `Request to erase my personal data used for AI training – ${c.svc}`,
        legalBasis:
          'Digital Personal Data Protection Act, 2023: s. 6(4) (withdrawal of consent), s. 12 (erasure), s. 8(7) (erasure when consent is withdrawn). The Act is being brought into force in phases.',
        citations: ['DPDP Act 2023 s. 6(4)', 'DPDP Act 2023 s. 8(7)', 'DPDP Act 2023 s. 12'],
        responseDeadline: '30 days (requested)',
        body: assemble(c, [
          introParagraph(
            c,
            `I am writing to ask you to erase personal data about me that you hold for ${AI_USE_DEF}.`,
          ),
          `I withdraw any consent I have given to ${c.co} to process my personal data for these purposes (section 6(4) of the Digital Personal Data Protection Act, 2023), and I request erasure of the personal data about me that you hold for them, including copies in datasets used to train, fine-tune or evaluate AI models (sections 8(7) and 12). If these provisions are not yet in force for your organisation, I ask you to honour this request now in the same way.`,
          `This request does not ask you to close my ${c.svc} account.`,
          `Please confirm in writing:\n${numbered([
            'that you, and any Data Processor acting for you, have erased this data, and when;',
            'whether this data has already been used to train AI models that you use or make available, and what you have done about it;',
            'that my personal data will not be used for these purposes in future.',
          ])}`,
          MODEL_CAVEAT,
          'I would be grateful for your reply within 30 days of receiving this letter.',
          identityBlock(c),
        ]),
      };
    },
    JP(c) {
      return {
        subject: `Request to stop using and erase my personal data used for AI training (APPI Art. 35) – ${c.svc}`,
        legalBasis:
          'Act on the Protection of Personal Information (APPI): Art. 35(1) and 35(5) (cessation of use or erasure of retained personal data)',
        citations: ['APPI Art. 18', 'APPI Art. 35(1)', 'APPI Art. 35(5)'],
        responseDeadline: 'Without delay (APPI); 30 days requested',
        body: assemble(c, [
          introParagraph(
            c,
            `I am writing to ask you to stop using, and to erase, personal data about me that you hold for ${AI_USE_DEF}.`,
          ),
          `I do not consent to my personal data being used for these purposes. If this use goes beyond the purpose of use that you have specified (Article 18 APPI), I request under Article 35(1) APPI that you cease using and erase my retained personal data held for it. I also make this request under Article 35(5) APPI, because I consider that this use is likely to harm my rights or legitimate interests. This includes copies in datasets used to train, fine-tune or evaluate AI models.`,
          `This request does not ask you to close my ${c.svc} account.`,
          `Please confirm in writing:\n${numbered([
            'whether you will cease using and erase this data, and if not, why not;',
            'whether this data has already been used to train AI models that you use or make available, and what you have done about it;',
            'that my personal data will not be used for these purposes in future.',
          ])}`,
          MODEL_CAVEAT,
          'The APPI requires you to notify me without delay of your decision. I would be grateful for your reply within 30 days of receiving this letter.',
          identityBlock(c),
          'If I am not satisfied with your response, I may consult the Personal Information Protection Commission (PPC).',
        ]),
      };
    },
    OTHER(c) {
      return {
        subject: `Request to delete my personal data used for AI training – ${c.svc}`,
        legalBasis: 'Applicable data protection law and your privacy policy (no specific statute cited)',
        citations: [],
        responseDeadline: '30 days (requested)',
        body: assemble(c, [
          introParagraph(
            c,
            `I am writing to ask you to delete personal data about me that you hold for ${AI_USE_DEF}.`,
          ),
          `Please delete the personal data about me that you hold for these purposes, including copies in datasets used to train, fine-tune or evaluate AI models. Where data protection law that applies to you gives me a right to erasure or deletion, please treat this letter as exercising it.`,
          `This request does not ask you to close my ${c.svc} account.`,
          `Please confirm in writing:\n${numbered([
            'that you have deleted this data, and when;',
            'whether this data has already been used to train AI models that you use or make available, and what you have done about it;',
            'that my personal data will not be used for these purposes in future.',
          ])}`,
          MODEL_CAVEAT,
          'I would be grateful for your reply within 30 days of receiving this letter.',
          identityBlock(c),
        ]),
      };
    },
  },

  access: {
    EU: accessGdpr,
    UK: accessGdpr,
    CH(c) {
      return {
        subject: `Request for information about my personal data (Art. 25 FADP) – ${c.svc}`,
        legalBasis:
          'Swiss FADP: Art. 25 (right to information), Art. 25(6) (free of charge), Art. 25(7) (30 days)',
        citations: ['Art. 25 FADP', 'Art. 25(6) FADP', 'Art. 25(7) FADP'],
        responseDeadline: '30 days (Art. 25(7) FADP)',
        body: assemble(c, [
          introParagraph(
            c,
            'I am writing to exercise my right to information under Article 25 of the Federal Act on Data Protection (FADP).',
          ),
          `Please tell me whether you process personal data about me and, if so, provide:\n${numbered([
            'the personal data about me that you process, as such;',
            'the purposes of the processing, stating specifically whether my personal data is used for developing, training or improving AI models, and for which models or products;',
            'how long the data is kept, or the criteria used to decide this;',
            'where the data came from, if you did not collect it from me;',
            'whether any automated individual decision is made about me;',
            'the recipients or categories of recipients to whom the data is disclosed, including anyone who receives it for AI training, and the countries concerned.',
          ])}`,
          `Please also tell me whether my personal data is currently excluded from AI training and, if so, since when.`,
          'Under Article 25 FADP, this information must generally be provided free of charge and within 30 days.',
          identityBlock(c),
          'If necessary, I may contact the Federal Data Protection and Information Commissioner (FDPIC).',
        ]),
      };
    },
    'US-CA'(c) {
      return {
        subject: `Request to know what personal information you hold about me (CCPA) – ${c.svc}`,
        legalBasis:
          'CCPA as amended by the CPRA: Cal. Civ. Code §§ 1798.100, 1798.110 and 1798.115 (right to know), § 1798.130 (45-day response), § 1798.125 (non-discrimination)',
        citations: [
          'Cal. Civ. Code § 1798.100',
          'Cal. Civ. Code § 1798.110',
          'Cal. Civ. Code § 1798.115',
          'Cal. Civ. Code § 1798.130',
        ],
        responseDeadline: '45 calendar days, extendable once by 45 days with notice (§ 1798.130)',
        body: assemble(c, [
          introParagraph(
            c,
            'I am a California resident and I am writing to exercise my right to know under the California Consumer Privacy Act (CCPA).',
          ),
          `Under Cal. Civ. Code §§ 1798.100, 1798.110 and 1798.115, please provide:\n${numbered([
            'the specific pieces of personal information you have collected about me;',
            'the categories of personal information you have collected about me and the categories of sources;',
            'the business or commercial purposes for collecting, selling or sharing it, stating specifically whether it is used for developing, training or improving AI models;',
            'the categories of third parties to whom you disclose it, and the categories of personal information you have sold or shared and to whom.',
          ])}`,
          'Please cover all the personal information you hold about me, not only the last 12 months, as the CCPA allows for information collected on or after January 1, 2022. Please also tell me whether my personal information is currently excluded from AI training.',
          'Cal. Civ. Code § 1798.130 requires you to respond free of charge within 45 calendar days of receiving this request. That period may be extended once by a further 45 days when reasonably necessary, if you tell me within the first 45 days. You may not discriminate against me for making this request (§ 1798.125).',
          identityBlock(c),
          'If I am not satisfied with your response, I may contact the California Privacy Protection Agency (https://cppa.ca.gov/).',
        ]),
      };
    },
    US(c) {
      return {
        subject: `Request for access to my personal data – ${c.svc}`,
        legalBasis:
          'Comprehensive state consumer privacy laws (for example in Virginia, Colorado, Connecticut, Texas and Oregon): right to confirm and access, 45-day response, right to appeal',
        citations: ['State consumer privacy law of the consumer’s state of residence'],
        responseDeadline: '45 days under most state privacy laws (extendable once by 45 days)',
        body: assemble(c, [
          introParagraph(c, 'I am writing to ask what personal data you hold about me and how you use it.'),
          `I live in ${PLACEHOLDERS.state}. If a consumer privacy law applies in my state, please treat this letter as a request to confirm whether you process my personal data and to access it under that law. In any case, please provide:\n${numbered(
            [
              'confirmation of whether you process personal data about me, and a copy of that data;',
              'the purposes for which you use it, stating specifically whether it is used for developing, training or improving AI models;',
              'the categories of third parties to whom you disclose it, including anyone who receives it for AI training;',
              'whether my personal data is currently excluded from AI training and, if so, since when.',
            ],
          )}`,
          'State privacy laws such as those of Virginia, Colorado, Connecticut, Texas and Oregon generally require a response within 45 days, which may be extended once by 45 days. If you decline any part of this request, please explain why and tell me how to appeal your decision.',
          identityBlock(c),
        ]),
      };
    },
    CA(c) {
      return {
        subject: `Request for access to my personal information (PIPEDA) – ${c.svc}`,
        legalBasis:
          'PIPEDA: Schedule 1, Principle 4.9 (individual access), s. 8(3) (30-day response), s. 8(4) (extension)',
        citations: ['PIPEDA Sch. 1, Principle 4.9', 'PIPEDA s. 8(3)', 'PIPEDA s. 8(4)'],
        responseDeadline: '30 days, extendable in limited cases (PIPEDA s. 8(3)–(4))',
        body: assemble(c, [
          introParagraph(
            c,
            'I am writing to request access to my personal information under the Personal Information Protection and Electronic Documents Act (PIPEDA).',
          ),
          `Under Principle 4.9 of Schedule 1 to PIPEDA, please:\n${numbered([
            'tell me whether you hold personal information about me, and give me access to it;',
            'tell me how that information has been and is being used, stating specifically whether it is used for developing, training or improving AI models;',
            'tell me the third parties to whom it has been disclosed, including anyone who received it for AI training;',
            'tell me whether my personal information is currently excluded from AI training and, if so, since when.',
          ])}`,
          'Under section 8(3) of PIPEDA, you must respond within 30 days of receiving this request, unless the time limit is extended in accordance with section 8(4).',
          identityBlock(c),
          'If I am not satisfied with your response, I may file a complaint with the Office of the Privacy Commissioner of Canada (https://www.priv.gc.ca/).',
        ]),
      };
    },
    AU(c) {
      return {
        subject: `Request for access to my personal information (APP 12) – ${c.svc}`,
        legalBasis:
          'Privacy Act 1988 (Cth): Australian Privacy Principle 12 (access to personal information)',
        citations: ['APP 12', 'APP 1.4'],
        responseDeadline: 'A reasonable period (APP 12.4); 30 days requested',
        body: assemble(c, [
          introParagraph(
            c,
            'I am writing to request access to my personal information under Australian Privacy Principle 12.',
          ),
          `Please give me access to the personal information you hold about me. Please also tell me:\n${numbered(
            [
              'the purposes for which you use it, stating specifically whether it is used for developing, training or improving AI models;',
              'whether you disclose it to third parties for AI training, and if so, to whom;',
              'whether my personal information is currently excluded from AI training and, if so, since when.',
            ],
          )}`,
          'APP 12 requires you to respond within a reasonable period after my request. I would be grateful for your reply within 30 days.',
          identityBlock(c),
          'If I do not receive a satisfactory response within 30 days, I may complain to the Office of the Australian Information Commissioner (https://www.oaic.gov.au/privacy/privacy-complaints).',
        ]),
      };
    },
    BR(c) {
      return {
        subject: `Request for confirmation of and access to my personal data (LGPD, Art. 18 and 19) – ${c.svc}`,
        legalBasis:
          'LGPD (Law 13.709/2018): Art. 18 I, II and VII (confirmation, access, sharing), Art. 19 II (complete declaration within 15 days)',
        citations: ['LGPD Art. 18 I', 'LGPD Art. 18 II', 'LGPD Art. 18 VII', 'LGPD Art. 19 II'],
        responseDeadline: '15 days for a complete declaration (LGPD Art. 19 II)',
        body: assemble(c, [
          introParagraph(
            c,
            'I am writing to exercise my rights under the General Data Protection Law (LGPD).',
          ),
          `Under Article 18, I, II and VII and Article 19, II LGPD, please provide a clear and complete declaration including:\n${numbered(
            [
              'confirmation of whether you process personal data about me, and access to that data;',
              'the origin of the data, the criteria used and the purposes of the processing, stating specifically whether it is used for developing, training or improving AI models;',
              'the public and private entities with which you have shared my data, including for AI training;',
              'the legal basis you rely on to use my data for AI training, and whether my data is currently excluded from it.',
            ],
          )}`,
          'Article 19, II LGPD requires a complete declaration within 15 days of my request, and Article 18, §5 requires the request to be handled free of charge.',
          identityBlock(c),
          'If I am not satisfied with your response, I may petition the National Data Protection Authority (ANPD) under Article 18, §1 LGPD.',
        ]),
      };
    },
    IN(c) {
      return {
        subject: `Request for information about my personal data – ${c.svc}`,
        legalBasis:
          'Digital Personal Data Protection Act, 2023: s. 11 (right to access information about personal data). The Act is being brought into force in phases.',
        citations: ['DPDP Act 2023 s. 11'],
        responseDeadline: '30 days (requested)',
        body: assemble(c, [
          introParagraph(c, 'I am writing to ask for information about the personal data you hold about me.'),
          `Section 11 of the Digital Personal Data Protection Act, 2023 gives a Data Principal the right to obtain a summary of her personal data and of the processing activities undertaken with it, and the identities of the other Data Fiduciaries and Data Processors with whom it has been shared. If this provision is not yet in force for your organisation, I ask you to provide the information anyway. Please provide:\n${numbered(
            [
              'a summary of the personal data about me that you process, and of the processing activities, stating specifically whether it is used for developing, training or improving AI models;',
              'the identities of the Data Fiduciaries and Data Processors with whom you have shared it, and a description of what was shared;',
              'whether my personal data is currently excluded from AI training and, if so, since when.',
            ],
          )}`,
          'I would be grateful for your reply within 30 days of receiving this letter.',
          identityBlock(c),
        ]),
      };
    },
    JP(c) {
      return {
        subject: `Request for disclosure of my retained personal data (APPI Art. 33) – ${c.svc}`,
        legalBasis:
          'Act on the Protection of Personal Information (APPI): Art. 33 (disclosure of retained personal data), Art. 32 (purpose of use of retained personal data)',
        citations: ['APPI Art. 32', 'APPI Art. 33'],
        responseDeadline: 'Without delay (APPI Art. 33)',
        body: assemble(c, [
          introParagraph(
            c,
            'I am writing to request disclosure of my retained personal data under the Act on the Protection of Personal Information (APPI).',
          ),
          `Under Article 33 APPI, please disclose the retained personal data that can identify me. Please also tell me:\n${numbered(
            [
              'the purpose of use of that retained personal data (Article 32), stating specifically whether it is used for developing, training or improving AI models;',
              'whether you provide it to third parties for AI training, and if so, to whom;',
              'whether my personal data is currently excluded from AI training and, if so, since when.',
            ],
          )}`,
          'Article 33 APPI requires you to disclose the data without delay. If you charge a fee, please tell me the amount in advance.',
          identityBlock(c),
          'If I am not satisfied with your response, I may consult the Personal Information Protection Commission (PPC).',
        ]),
      };
    },
    OTHER(c) {
      return {
        subject: `Request for access to my personal data – ${c.svc}`,
        legalBasis: 'Applicable data protection law and your privacy policy (no specific statute cited)',
        citations: [],
        responseDeadline: '30 days (requested)',
        body: assemble(c, [
          introParagraph(c, 'I am writing to ask what personal data you hold about me and how you use it.'),
          `Please provide:\n${numbered([
            'confirmation of whether you process personal data about me, and a copy of that data;',
            'the purposes for which you use it, stating specifically whether it is used for developing, training or improving AI models;',
            'the third parties to whom you disclose it, including anyone who receives it for AI training;',
            'whether my personal data is currently excluded from AI training and, if so, since when.',
          ])}`,
          'Where data protection law that applies to you gives me a right of access, please treat this letter as exercising it. I would be grateful for your reply within 30 days of receiving this letter.',
          identityBlock(c),
        ]),
      };
    },
  },

  'ccpa-opt-out': {
    'US-CA'(c) {
      return {
        subject: `Request to opt out of sale and sharing and to limit use of sensitive personal information – ${c.svc}`,
        legalBasis:
          'CCPA as amended by the CPRA: Cal. Civ. Code § 1798.120 (opt out of sale and sharing), § 1798.121 (limit use of sensitive personal information), § 1798.125 (non-discrimination); Cal. Code Regs., tit. 11, §§ 7026–7027 (15 business days)',
        citations: [
          'Cal. Civ. Code § 1798.120',
          'Cal. Civ. Code § 1798.121',
          'Cal. Civ. Code § 1798.125',
          'Cal. Civ. Code § 1798.140',
          'Cal. Code Regs., tit. 11, § 7026',
          'Cal. Code Regs., tit. 11, § 7027',
        ],
        responseDeadline:
          'As soon as feasibly possible, and no later than 15 business days (Cal. Code Regs., tit. 11, §§ 7026–7027)',
        body: assemble(c, [
          introParagraph(
            c,
            'I am a California resident and I am writing to exercise my rights under the California Consumer Privacy Act (CCPA).',
          ),
          `Please:\n${numbered([
            `stop selling and sharing my personal information (Cal. Civ. Code § 1798.120). Making my personal information available to a third party for monetary or other valuable consideration, for example by licensing ${c.svc} content that contains it for training AI models, would generally be a sale under the CCPA (§ 1798.140);`,
            'limit your use and disclosure of my sensitive personal information to what is necessary to provide the services I request (§ 1798.121).',
          ])}`,
          `In addition, although California law does not give me a specific right to object to AI training, I ask that you do not use my personal information for ${AI_USE}, and that you turn off any such use on my account.`,
          settingNote(c),
          'A request to opt out of sale or sharing does not need to be a verifiable consumer request. The CCPA regulations require you to act on these requests as soon as feasibly possible and no later than 15 business days after receiving them, and to notify third parties to whom you have sold or shared my personal information since receiving this request. You may not discriminate against me for making these requests (§ 1798.125).',
          `Please confirm in writing:\n${numbered([
            'that you have processed my requests to opt out of sale and sharing and to limit the use of my sensitive personal information;',
            'whether you will stop using my personal information for AI training and, if so, from which date.',
          ])}`,
          identityBlock(c),
          'If I am not satisfied with your response, I may contact the California Privacy Protection Agency (https://cppa.ca.gov/).',
        ]),
      };
    },
  },

  generic: {
    '*'(c) {
      const law = GENERIC_LAW_NAMES[c.region];
      return {
        subject: `Request to stop using my personal data for AI training – ${c.svc}`,
        legalBasis: law
          ? `A plain request that mentions ${law} without relying on specific provisions`
          : 'A plain request based on your privacy policy (no specific statute cited)',
        citations: [],
        responseDeadline: '30 days (requested)',
        body: assemble(c, [
          introParagraph(c, `I am writing to ask you to stop using my personal data for ${AI_USE_DEF}.`),
          `Please stop using personal data about me, including ${c.data}, for these purposes, and exclude it from any datasets used for future training. Where your privacy policy or data protection law that applies to you${law ? ` (such as ${law})` : ''} gives me a right to object, to withdraw consent or to opt out, please treat this letter as exercising that right.`,
          settingNote(c),
          `Please confirm in writing:\n${numbered([
            'that you will no longer use my personal data for these purposes;',
            ...CONFIRM_TRAINING(c),
          ])}\nIf there is a setting or form I also need to use, please tell me.`,
          'I would be grateful for your reply within 30 days of receiving this letter.',
          identityBlock(c),
        ]),
      };
    },
  },
};

function objectionGdpr(c) {
  const g = gdprVariant(c.region);
  return {
    subject: `Objection to the use of my personal data for AI training (Article 21 ${g.law}) – ${c.svc}`,
    legalBasis: `${g.law}: Art. 21(1) (right to object to processing based on legitimate interests), Art. 7(3) (withdrawal of consent), Art. 18(1)(d) (restriction while the objection is assessed)${g.uk ? '' : ', Art. 12(3) (one-month deadline)'}`,
    citations: [
      g.art('21(1)'),
      g.art('6(1)(f)'),
      g.art('7(3)'),
      g.art('18(1)(d)'),
      ...(g.uk ? [] : [g.art('12(3)'), g.art('77')]),
    ],
    responseDeadline: 'One month from receipt, extendable by two further months with notice and reasons',
    body: assemble(c, [
      introParagraph(c, `I am writing to object to the processing of my personal data for ${AI_USE_DEF}.`),
      `Objection (${g.art('21(1)')}): To the extent that ${c.co} relies on legitimate interests (${g.art('6(1)(f)')}) to process my personal data for these purposes, I object to that processing on grounds relating to my particular situation. ${particularSituation(c)} Following this objection, you may no longer process my personal data for these purposes unless you demonstrate compelling legitimate grounds which override my interests, rights and freedoms, or the processing is necessary for the establishment, exercise or defence of legal claims.`,
      `Withdrawal of consent (${g.art('7(3)')}): To the extent that you rely on my consent for this processing, I withdraw it.`,
      `Restriction (${g.art('18(1)(d)')}): While you assess my objection, please restrict the processing of my personal data for these purposes.`,
      `This covers personal data you already hold as well as data you collect in future, and any AI model developed by ${c.co}, its affiliates or third parties to whom you disclose my personal data for these purposes.`,
      settingNote(c),
      `Please confirm in writing:\n${numbered([
        'that you have stopped, or will stop, processing my personal data for these purposes;',
        ...CONFIRM_TRAINING(c),
      ])}\nIf you believe you have compelling legitimate grounds that override my objection, please set them out.`,
      g.deadline,
      `${g.identity}\n\n${identityBlock(c)}`,
      g.escalation,
    ]),
  };
}

function erasureGdpr(c) {
  const g = gdprVariant(c.region);
  return {
    subject: `Request to erase my personal data used for AI training (Article 17 ${g.law}) – ${c.svc}`,
    legalBasis: `${g.law}: Art. 17(1)(b) and (c) (erasure after withdrawal of consent or objection), Art. 21(1) (objection), Art. 19 (notifying recipients)${g.uk ? '' : ', Art. 12(3) (one-month deadline)'}`,
    citations: [
      g.art('17(1)(b)'),
      g.art('17(1)(c)'),
      g.art('21(1)'),
      g.art('7(3)'),
      g.art('19'),
      ...(g.uk ? [] : [g.art('12(3)'), g.art('77')]),
    ],
    responseDeadline: 'One month from receipt, extendable by two further months with notice and reasons',
    body: assemble(c, [
      introParagraph(
        c,
        `I am writing to ask you to erase personal data about me that you hold for ${AI_USE_DEF}.`,
      ),
      `To the extent that you rely on legitimate interests for this processing, I object to it under ${g.art('21(1)')} on grounds relating to my particular situation: ${particularSituation(c)} To the extent that you rely on my consent, I withdraw it (${g.art('7(3)')}).`,
      `I therefore request erasure, without undue delay, of the personal data about me that you hold for these purposes, including copies in datasets used to train, fine-tune or evaluate AI models (Article 17(1)(b) and (c) ${g.law}). This request does not ask you to close my ${c.svc} account or to erase data you need to provide the service to me.`,
      `Please also communicate this erasure to each recipient to whom you have disclosed this data, and tell me who those recipients are (${g.art('19')}).`,
      `Please confirm in writing:\n${numbered([
        'that you have erased this data, and when;',
        'whether this data has already been used to train AI models that you use or make available, and what you have done about it;',
        'that my personal data will not be used for these purposes in future.',
      ])}`,
      MODEL_CAVEAT,
      g.deadline,
      `${g.identity}\n\n${identityBlock(c)}`,
      g.escalation,
    ]),
  };
}

function accessGdpr(c) {
  const g = gdprVariant(c.region);
  return {
    subject: `Subject access request (Article 15 ${g.law}) – ${c.svc}`,
    legalBasis: `${g.law}: Art. 15 (right of access), Art. 12(5) (free of charge)${g.uk ? '' : ', Art. 12(3) (one-month deadline)'}`,
    citations: [
      g.art('15(1)'),
      g.art('15(3)'),
      ...(g.uk ? [] : [g.art('12(5)'), g.art('12(3)'), g.art('77')]),
    ],
    responseDeadline: 'One month from receipt, extendable by two further months with notice and reasons',
    body: assemble(c, [
      introParagraph(c, `I am writing to make a subject access request under ${g.art('15')}.`),
      `Please confirm whether you process personal data about me and, if so, provide:\n${numbered([
        `a copy of the personal data about me that you process (${g.art('15(3)')});`,
        `the purposes of the processing (${g.art('15(1)(a)')}), stating specifically whether my personal data is used for developing, training or improving AI models, and for which models or products;`,
        `the categories of personal data concerned (${g.art('15(1)(b)')}), including any included in training datasets;`,
        `the recipients or categories of recipients to whom it has been or will be disclosed (${g.art('15(1)(c)')}), including anyone who receives it for AI training;`,
        `how long it will be stored, or the criteria used to decide this (${g.art('15(1)(d)')});`,
        `where it came from, if you did not collect it from me (${g.art('15(1)(g)')});`,
        `whether any automated decision-making, including profiling, is carried out, with meaningful information about the logic involved (${g.art('15(1)(h)')}).`,
      ])}`,
      'Please also tell me which legal basis you rely on to use my personal data for AI training and, if it is legitimate interests, what those interests are, and whether my personal data is currently excluded from AI training.',
      `${g.uk ? 'Under the UK GDPR this information must be provided free of charge.' : `Under ${g.art('12(5)')} this information must be provided free of charge.`} ${g.deadline}`,
      `${g.identity}\n\n${identityBlock(c)}`,
      g.escalation,
    ]),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a request letter.
 *
 * @param {object} args
 * @param {object} args.service registry service entry
 * @param {object} [args.optOut] the opt-out the letter was started from (optional)
 * @param {string} args.region region code (lib/region.js); unknown codes are treated as OTHER
 * @param {'objection'|'erasure'|'access'|'ccpa-opt-out'|'generic'} args.kind
 * @param {{ fullName?: string, email?: string }} [args.profile]
 * @param {Date|string} [args.date] defaults to today
 * @returns {{ kind: string, region: string, subject: string, body: string, to: string|null,
 *   mailto?: string, formUrl: string|null, legalBasis: string, citations: string[],
 *   responseDeadline: string, authority: { name: string|null, url: string|null } }}
 */
export function generateLetter({ service, optOut, region, kind, profile, date } = {}) {
  if (!service || typeof service !== 'object') throw new TypeError('generateLetter: service is required');
  if (!KIND_IDS.has(kind)) throw new RangeError(`generateLetter: unknown letter kind "${kind}"`);
  const code = ALL_REGIONS.includes(region) ? region : 'OTHER';
  if (!LETTER_KINDS.find((k) => k.id === kind).regions.includes(code)) {
    throw new RangeError(`generateLetter: a "${kind}" letter is not available for region ${code}`);
  }

  const c = context({ service, optOut, region: code, profile, date });
  const templates = TEMPLATES[kind];
  const build = templates[code] ?? templates['*'] ?? templates.OTHER;
  const letter = build(c);

  const result = {
    kind,
    region: code,
    subject: letter.subject,
    body: `${letter.body}\n`,
    to: c.to,
    formUrl: c.formUrl,
    legalBasis: letter.legalBasis,
    citations: letter.citations,
    responseDeadline: letter.responseDeadline,
    authority: { ...AUTHORITIES[code] },
  };
  if (c.to) result.mailto = buildMailto(c.to, result.subject, result.body);
  return result;
}
