import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  LETTER_KINDS,
  PLACEHOLDERS,
  availableKinds,
  buildMailto,
  describeData,
  formatLetterDate,
  generateLetter,
} from '../../extension/lib/letters.js';
import { REGIONS } from '../../extension/lib/region.js';

const REGION_CODES = REGIONS.map((r) => r.code);

const service = Object.freeze({
  id: 'example-ai',
  name: 'Example AI',
  company: 'Example Corp',
  training: {
    trainsOnUserData: 'yes',
    defaultState: 'opted_in',
    dataTypes: ['chats', 'files', 'voice'],
    details: 'Conversations are used to train models unless you opt out.',
    retroactiveRemoval: false,
  },
  optOuts: [
    {
      id: 'toggle',
      type: 'toggle',
      title: 'Turn off “Improve the model”',
      url: 'https://example.com/settings',
      regions: ['ALL'],
      effort: 'quick',
      steps: ['Open settings.'],
      effect: 'Stops future training.',
    },
  ],
  contacts: {
    privacyEmail: 'privacy@example.com',
    dpoEmail: 'dpo@example.eu',
    privacyRequestUrl: 'https://example.com/privacy-request',
  },
});

const profile = { fullName: 'Ada Lovelace', email: 'ada@example.org' };

function decodeMailto(mailto) {
  const url = new URL(mailto);
  return {
    to: decodeURIComponent(url.pathname),
    subject: url.searchParams.get('subject'),
    body: url.searchParams.get('body'),
  };
}

describe('LETTER_KINDS and availableKinds', () => {
  test('every kind has an id, label, description and valid regions', () => {
    const ids = new Set();
    for (const k of LETTER_KINDS) {
      assert.match(k.id, /^[a-z-]+$/);
      assert.ok(!ids.has(k.id), `duplicate kind ${k.id}`);
      ids.add(k.id);
      assert.ok(k.label.length > 3);
      assert.ok(k.description.length > 10);
      assert.ok(k.regions.length > 0);
      for (const r of k.regions) assert.ok(REGION_CODES.includes(r), `${k.id}: unknown region ${r}`);
    }
    assert.deepEqual([...ids].sort(), ['access', 'ccpa-opt-out', 'erasure', 'generic', 'objection']);
  });

  test('GDPR-style regions get the objection letter first', () => {
    for (const r of ['EU', 'UK', 'CH']) {
      assert.deepEqual(
        availableKinds(r).map((k) => k.id),
        ['objection', 'generic', 'erasure', 'access'],
      );
    }
  });

  test('California gets the CCPA opt-out and no GDPR-style objection', () => {
    const ids = availableKinds('US-CA').map((k) => k.id);
    assert.equal(ids[0], 'ccpa-opt-out');
    assert.ok(!ids.includes('objection'));
  });

  test('regions without an objection right fall back to the plain request', () => {
    for (const r of ['US', 'OTHER', 'nonsense', undefined]) {
      assert.deepEqual(
        availableKinds(r).map((k) => k.id),
        ['generic', 'erasure', 'access'],
      );
    }
  });

  test('labels are adapted to the local law', () => {
    assert.equal(
      availableKinds('CA').find((k) => k.id === 'objection').label,
      'Withdraw consent to AI training',
    );
    assert.equal(availableKinds('EU').find((k) => k.id === 'objection').label, 'Object to AI training');
  });
});

describe('generateLetter: every region and kind', () => {
  for (const region of REGION_CODES) {
    for (const { id: kind } of availableKinds(region)) {
      test(`${region} / ${kind}`, () => {
        const letter = generateLetter({
          service,
          optOut: service.optOuts[0],
          region,
          kind,
          profile,
          date: '2026-09-28',
        });
        assert.equal(letter.kind, kind);
        assert.equal(letter.region, region);
        assert.ok(letter.subject.includes('Example AI'), 'subject names the service');
        assert.ok(letter.body.includes('Example AI'), 'body names the service');
        assert.ok(letter.body.includes('Example Corp'), 'body names the company');
        assert.ok(letter.body.includes('Ada Lovelace'));
        assert.ok(letter.body.includes('ada@example.org'));
        assert.match(letter.body, /in writing|provide|give me access|disclose/i, 'asks for a written answer');
        assert.match(letter.body, /AI/);
        assert.ok(letter.body.endsWith('\n'));
        assert.doesNotMatch(letter.body, /undefined|null|\[object Object\]|\$\{/);
        assert.doesNotMatch(letter.subject, /undefined|null/);
        assert.equal(typeof letter.legalBasis, 'string');
        assert.ok(letter.legalBasis.length > 10);
        assert.ok(Array.isArray(letter.citations));
        assert.equal(typeof letter.responseDeadline, 'string');
        assert.ok(letter.to);
        assert.ok(letter.mailto.startsWith('mailto:'));
        const decoded = decodeMailto(letter.mailto);
        assert.equal(decoded.subject, letter.subject);
        assert.equal(decoded.body.replace(/\r\n/g, '\n'), letter.body);
        // No paragraph should be accidentally duplicated.
        const paras = letter.body.split('\n\n').filter((p) => p.length > 60);
        assert.equal(new Set(paras).size, paras.length);
      });
    }
  }
});

describe('generateLetter: legal content', () => {
  const gen = (region, kind, extra = {}) =>
    generateLetter({ service, region, kind, profile, date: '2026-09-28', ...extra });

  test('EU objection cites Art. 21(1), 6(1)(f), 7(3), 18(1)(d), 12(3) and 77 GDPR', () => {
    const { body, subject } = gen('EU', 'objection');
    assert.match(subject, /Article 21 GDPR/);
    for (const art of ['21(1)', '6(1)(f)', '7(3)', '18(1)(d)', '12(3)', '77']) {
      assert.ok(body.includes(`Article ${art} GDPR`), `cites Article ${art}`);
    }
    assert.match(body, /particular situation/);
    assert.match(body, /compelling legitimate grounds/);
    assert.match(body, /one month/);
  });

  test('UK letters use UK GDPR and the ICO, without EU-only article numbers for deadlines', () => {
    const { body } = gen('UK', 'objection');
    assert.match(body, /Article 21\(1\) UK GDPR/);
    assert.match(body, /ico\.org\.uk\/make-a-complaint/);
    assert.doesNotMatch(body, /Article 12\(3\)/);
    assert.doesNotMatch(body, /\bGDPR\b(?<!UK GDPR)/, 'every GDPR mention is "UK GDPR"');
  });

  test('erasure letters are scoped to AI training data and do not close the account', () => {
    for (const region of REGION_CODES) {
      const { body } = gen(region, 'erasure');
      assert.match(body, /datasets used to train, fine-tune or evaluate AI models/, region);
      assert.match(body, /close my Example AI account/, region);
      assert.match(
        body,
        /removing information from a model that has already been trained may be difficult/,
        region,
      );
    }
    assert.match(gen('EU', 'erasure').body, /Article 17\(1\)\(b\) and \(c\) GDPR/);
    assert.match(gen('EU', 'erasure').body, /Article 19 GDPR/);
  });

  test('access letters list the Art. 15 items', () => {
    const { body } = gen('EU', 'access');
    for (const item of ['15(3)', '15(1)(a)', '15(1)(b)', '15(1)(c)', '15(1)(d)', '15(1)(g)', '15(1)(h)']) {
      assert.ok(body.includes(`Article ${item} GDPR`), item);
    }
    assert.match(body, /free of charge/);
  });

  test('California letters cite the CCPA and its deadlines honestly', () => {
    const optOut = gen('US-CA', 'ccpa-opt-out');
    assert.match(optOut.body, /§ 1798\.120/);
    assert.match(optOut.body, /§ 1798\.121/);
    assert.match(optOut.body, /15 business days/);
    assert.match(optOut.body, /does not give me a specific right to object to AI training/);
    assert.match(optOut.body, /does not need to be a verifiable consumer request/);
    const erasure = gen('US-CA', 'erasure');
    assert.match(erasure.body, /§ 1798\.105/);
    assert.match(erasure.body, /45 calendar days/);
    assert.match(gen('US-CA', 'access').body, /§§ 1798\.100, 1798\.110 and 1798\.115/);
  });

  test('other regions cite their own law', () => {
    assert.match(gen('CH', 'objection').body, /Article 30\(2\)\(b\) of the Federal Act on Data Protection/);
    assert.match(gen('CH', 'access').body, /30 days/);
    assert.match(gen('CA', 'objection').body, /Principle 4\.3\.8/);
    assert.match(gen('CA', 'access').body, /section 8\(3\) of PIPEDA/);
    assert.match(gen('AU', 'objection').body, /Australian Privacy Principle \(APP\) 6/);
    assert.match(gen('AU', 'access').body, /Australian Privacy Principle 12/);
    assert.match(gen('BR', 'objection').body, /Article 18, §2 LGPD/);
    assert.match(gen('BR', 'access').body, /15 days/);
    assert.match(
      gen('IN', 'objection').body,
      /Section 6\(4\) of the Digital Personal Data Protection Act, 2023/,
    );
    assert.match(gen('IN', 'objection').body, /not yet in force/);
    assert.match(gen('JP', 'objection').body, /Article 35\(1\) APPI/);
    assert.match(gen('JP', 'access').body, /Article 33 APPI/);
    assert.match(gen('US', 'erasure').body, new RegExp(PLACEHOLDERS.state.replace(/[[\]]/g, '\\$&')));
  });

  test('the generic letter cites no statute but mentions the local law by name', () => {
    const eu = gen('EU', 'generic');
    assert.deepEqual(eu.citations, []);
    assert.match(eu.body, /such as the GDPR/);
    assert.doesNotMatch(eu.body, /Article \d/);
    const other = gen('OTHER', 'generic');
    assert.doesNotMatch(other.body, /\(such as/);
  });

  test('the opening reflects what the registry says about training', () => {
    const variant = (trainsOnUserData) =>
      gen('EU', 'objection', { service: { ...service, training: { ...service.training, trainsOnUserData } } })
        .body;
    assert.match(variant('yes'), /Example Corp uses personal data from Example AI/);
    assert.match(variant('conditional'), /may in some circumstances use/);
    assert.match(variant('no'), /states that Example Corp does not use personal data/);
    assert.match(variant('unknown'), /It is not clear from your published documentation/);
  });

  test('mentions the in-product setting when started from one', () => {
    const { body } = gen('EU', 'objection', { optOut: service.optOuts[0] });
    assert.match(body, /offers this option: Turn off “Improve the model”\./);
    assert.doesNotMatch(gen('EU', 'objection').body, /offers this option/);
  });
});

describe('generateLetter: recipients, placeholders and mailto', () => {
  test('uses placeholders for missing profile fields', () => {
    const { body } = generateLetter({
      service,
      region: 'EU',
      kind: 'objection',
      profile: {},
      date: '2026-09-28',
    });
    assert.ok(body.includes(PLACEHOLDERS.fullName));
    assert.ok(body.includes(PLACEHOLDERS.email));
    assert.ok(body.includes(PLACEHOLDERS.accountEmail));
  });

  test('strips line breaks from profile values', () => {
    const { body } = generateLetter({
      service,
      region: 'OTHER',
      kind: 'generic',
      profile: { fullName: 'Ada\r\nBcc: evil@example.com', email: ' ada@example.org ' },
    });
    assert.ok(body.includes('Ada Bcc: evil@example.com'));
    assert.doesNotMatch(body, /\nBcc:/);
  });

  test('prefers the DPO under GDPR-style laws and the privacy team elsewhere', () => {
    const eu = generateLetter({ service, region: 'EU', kind: 'objection', profile });
    assert.equal(eu.to, 'dpo@example.eu');
    assert.match(eu.body, /Dear Data Protection Officer,/);
    const us = generateLetter({ service, region: 'US-CA', kind: 'ccpa-opt-out', profile });
    assert.equal(us.to, 'privacy@example.com');
    assert.match(us.body, /Dear Privacy Team,/);
  });

  test('omits mailto when there is no email contact and exposes the form URL', () => {
    const noEmail = { ...service, contacts: { privacyRequestUrl: 'https://example.com/form' } };
    const letter = generateLetter({ service: noEmail, region: 'EU', kind: 'access', profile });
    assert.equal(letter.to, null);
    assert.ok(!('mailto' in letter));
    assert.equal(letter.formUrl, 'https://example.com/form');
  });

  test('ignores malformed contact emails', () => {
    const bad = { ...service, contacts: { privacyEmail: 'not an email', dpoEmail: 'x@y' } };
    const letter = generateLetter({ service: bad, region: 'EU', kind: 'access', profile });
    assert.equal(letter.to, null);
    assert.ok(!('mailto' in letter));
  });

  test('buildMailto percent-encodes per RFC 6068 and sends CRLF line breaks', () => {
    const url = buildMailto('privacy+ai@example.com', 'A & B? #1', 'Line 1\nLine 2 & more = 100%');
    assert.ok(url.startsWith('mailto:privacy%2Bai@example.com?subject='));
    assert.ok(!url.includes(' '));
    assert.ok(url.includes('%0D%0A'));
    assert.ok(!/%0A(?<!%0D%0A)/.test(url.replace(/%0D%0A/g, '')));
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('subject'), 'A & B? #1');
    assert.equal(parsed.searchParams.get('body'), 'Line 1\r\nLine 2 & more = 100%');
  });
});

describe('errors and helpers', () => {
  test('rejects unknown kinds and kinds not offered in a region', () => {
    assert.throws(() => generateLetter({ service, region: 'EU', kind: 'nope' }), RangeError);
    assert.throws(() => generateLetter({ service, region: 'US-CA', kind: 'objection' }), RangeError);
    assert.throws(() => generateLetter({ service, region: 'EU', kind: 'ccpa-opt-out' }), RangeError);
    assert.throws(() => generateLetter({ region: 'EU', kind: 'generic' }), TypeError);
  });

  test('unknown regions are treated as OTHER', () => {
    assert.equal(generateLetter({ service, region: 'XX', kind: 'generic', profile }).region, 'OTHER');
  });

  test('formatLetterDate uses the regional convention without time-zone shifts', () => {
    assert.equal(formatLetterDate('2026-09-28', 'EU'), '28 September 2026');
    assert.equal(formatLetterDate('2026-09-28', 'US'), 'September 28, 2026');
    assert.equal(formatLetterDate('2026-01-01', 'US-CA'), 'January 1, 2026');
    assert.equal(formatLetterDate(new Date(2026, 1, 3), 'UK'), '3 February 2026');
    assert.match(formatLetterDate(undefined, 'EU'), /^\d{1,2} [A-Z][a-z]+ \d{4}$/);
    assert.match(formatLetterDate('garbage', 'EU'), /^\d{1,2} [A-Z][a-z]+ \d{4}$/);
  });

  test('describeData lists the data types in plain words', () => {
    assert.equal(describeData(service), 'my conversations, uploaded files and voice recordings');
    assert.equal(describeData({ training: { dataTypes: ['posts'] } }), 'my posts');
    assert.equal(describeData({ training: { dataTypes: [] } }), 'my content and account data');
  });
});
