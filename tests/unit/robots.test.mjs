import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AI_TXT_TYPES,
  ROBOTS_PRESETS,
  SEARCH_ENGINE_TOKENS,
  generateAiTxt,
  generateMetaTags,
  generateRobotsTxt,
  generateTdmRep,
  selectCrawlers,
} from '../../extension/lib/robots.js';

const crawlers = [
  {
    token: 'GPTBot',
    operator: 'OpenAI',
    purpose: 'training',
    respectsRobotsTxt: true,
    docsUrl: 'https://x',
    notes: 'Training crawler.',
  },
  {
    token: 'OAI-SearchBot',
    operator: 'OpenAI',
    purpose: 'search',
    respectsRobotsTxt: true,
    docsUrl: 'https://x',
  },
  {
    token: 'ChatGPT-User',
    operator: 'OpenAI',
    purpose: 'user-triggered',
    respectsRobotsTxt: true,
    docsUrl: 'https://x',
  },
  {
    token: 'Google-Extended',
    operator: 'Google',
    purpose: 'training',
    respectsRobotsTxt: true,
    docsUrl: 'https://x',
  },
  {
    token: 'Bytespider',
    operator: 'ByteDance',
    purpose: 'mixed',
    respectsRobotsTxt: false,
    docsUrl: 'https://x',
    notes: 'Line one.\nDisallow: /evil',
  },
  // A regular search crawler that should never be blocked by a preset.
  {
    token: 'Googlebot',
    operator: 'Google',
    purpose: 'search',
    respectsRobotsTxt: true,
    docsUrl: 'https://x',
  },
];

/** Minimal RFC 9309 group parser: token (lowercase) → rules of the group naming it. */
function parseRobots(text) {
  const groups = new Map();
  let agents = [];
  let inRules = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [field, ...rest] = line.split(':');
    const value = rest.join(':').trim();
    if (/^user-agent$/i.test(field)) {
      if (inRules) {
        agents = [];
        inRules = false;
      }
      agents.push(value.toLowerCase());
      if (!groups.has(value.toLowerCase())) groups.set(value.toLowerCase(), []);
    } else {
      inRules = true;
      for (const a of agents) groups.get(a).push(`${field.toLowerCase()}:${value}`);
    }
  }
  return groups;
}

describe('selectCrawlers', () => {
  test('training preset blocks training and mixed crawlers only', () => {
    const tokens = selectCrawlers({ crawlers, block: 'training' }).map((c) => c.token);
    assert.deepEqual(tokens.sort(), ['Bytespider', 'GPTBot', 'Google-Extended']);
  });

  test('all-ai keeps AI search crawlers when asked, and never touches regular search engines', () => {
    const keep = selectCrawlers({ crawlers, block: 'all-ai', keepSearch: true }).map((c) => c.token);
    assert.ok(keep.includes('ChatGPT-User'));
    assert.ok(!keep.includes('OAI-SearchBot'));
    assert.ok(!keep.includes('Googlebot'));
    const all = selectCrawlers({ crawlers, block: 'all-ai', keepSearch: false }).map((c) => c.token);
    assert.ok(all.includes('OAI-SearchBot'));
    assert.ok(!all.includes('Googlebot'));
  });

  test('custom selects exactly the given tokens, case-insensitively, and drops invalid ones', () => {
    const picked = selectCrawlers({
      crawlers,
      block: 'custom',
      selectedTokens: ['gptbot', 'GPTBot', 'MyBot', 'Bad Bot\nDisallow: /', '', 'Googlebot'],
    });
    assert.deepEqual(
      picked.map((c) => c.token),
      ['GPTBot', 'Googlebot', 'MyBot'],
    );
  });
});

describe('generateRobotsTxt', () => {
  test('produces valid groups: only comments, User-agent and Disallow lines', () => {
    for (const block of ['training', 'all-ai', 'custom']) {
      const txt = generateRobotsTxt({ crawlers, block, selectedTokens: ['GPTBot'], date: '2026-09-28' });
      for (const line of txt.split('\n')) {
        if (!line) continue;
        assert.match(line, /^(#.*|User-agent: [A-Za-z0-9._-]+|Disallow: \/)$/, `${block}: ${line}`);
      }
      assert.ok(txt.endsWith('\n'));
    }
  });

  test('training preset disallows the right agents and leaves search engines alone', () => {
    const groups = parseRobots(generateRobotsTxt({ crawlers, block: 'training' }));
    for (const t of ['gptbot', 'google-extended', 'bytespider'])
      assert.deepEqual(groups.get(t), ['disallow:/'], t);
    for (const t of ['googlebot', 'oai-searchbot', 'chatgpt-user', '*']) assert.ok(!groups.has(t), t);
  });

  test('groups crawlers by operator with a heading and one Disallow per group', () => {
    const txt = generateRobotsTxt({ crawlers, block: 'all-ai', keepSearch: false, date: '2026-09-28' });
    const openai = txt.slice(txt.indexOf('# OpenAI'));
    const group = openai.slice(0, openai.indexOf('\n\n') === -1 ? undefined : openai.indexOf('\n\n'));
    assert.match(
      group,
      /User-agent: GPTBot\nUser-agent: OAI-SearchBot\nUser-agent: ChatGPT-User\nDisallow: \//,
    );
    assert.equal((group.match(/Disallow:/g) ?? []).length, 1);
    assert.ok(txt.indexOf('# ByteDance') < txt.indexOf('# OpenAI'), 'operators are sorted');
  });

  test('explains what robots.txt can and cannot do, and flags crawlers that ignore it', () => {
    const txt = generateRobotsTxt({ crawlers, block: 'training', date: '2026-09-28' });
    assert.match(txt, /generated by NoTrain on 2026-09-28/);
    assert.match(txt, /RFC 9309\) is a voluntary standard/);
    assert.match(txt, /does not remove content that has already been collected/);
    assert.match(txt, /Bytespider: used for AI training and other purposes\. Line one\. Disallow: \/evil\./);
    assert.match(txt, /Reported not to respect robots\.txt/);
    // The note's embedded newline must not create a real rule.
    assert.equal(parseRobots(txt).get('bytespider').length, 1);
  });

  test('custom mode can block a search engine but says what that means', () => {
    const txt = generateRobotsTxt({ crawlers, block: 'custom', selectedTokens: ['Googlebot'] });
    assert.match(txt, /Googlebot: a regular search-engine crawler\. Blocking it removes your site/);
    assert.deepEqual(parseRobots(txt).get('googlebot'), ['disallow:/']);
  });

  test('handles an empty selection and unknown presets', () => {
    assert.match(
      generateRobotsTxt({ crawlers, block: 'custom', selectedTokens: [] }),
      /No crawlers selected/,
    );
    assert.match(generateRobotsTxt({ crawlers: [] }), /No crawlers selected/);
    assert.match(generateRobotsTxt({ crawlers, block: 'weird' }), /Mode: block AI training crawlers/);
  });

  test('works with the crawlers in the compiled registry', () => {
    let registry;
    try {
      registry = JSON.parse(
        readFileSync(new URL('../../extension/data/registry.json', import.meta.url), 'utf8'),
      );
    } catch {
      return; // registry not built yet
    }
    const list = registry.crawlers ?? [];
    const txt = generateRobotsTxt({ crawlers: list, block: 'all-ai', keepSearch: false });
    const groups = parseRobots(txt);
    for (const c of list) {
      if (SEARCH_ENGINE_TOKENS.some((t) => t.toLowerCase() === c.token.toLowerCase())) continue;
      assert.deepEqual(groups.get(c.token.toLowerCase()), ['disallow:/'], c.token);
    }
    for (const t of SEARCH_ENGINE_TOKENS) assert.ok(!groups.has(t.toLowerCase()), `${t} must stay allowed`);
  });

  test('presets are documented', () => {
    assert.deepEqual(
      ROBOTS_PRESETS.map((p) => p.id),
      ['training', 'all-ai', 'custom'],
    );
  });
});

describe('generateAiTxt', () => {
  test('disallows everything by default, in Spawning format', () => {
    const txt = generateAiTxt({ date: '2026-09-28' });
    assert.ok(txt.startsWith('# Spawning AI\n# Prevent datasets from using the following file types\n'));
    assert.match(txt, /\nUser-Agent: \*\nDisallow: \/\n$/);
    assert.match(txt, /voluntary/);
  });

  test('lists extensions for the chosen types only', () => {
    const txt = generateAiTxt({ scope: 'types', types: ['images', 'bogus'] });
    for (const ext of AI_TXT_TYPES.images) assert.ok(txt.includes(`Disallow: *.${ext}\n`), ext);
    assert.ok(!txt.includes('Disallow: /\n'));
    assert.ok(!txt.includes('*.mp3'));
  });

  test('falls back to disallowing everything when no valid type is chosen', () => {
    assert.match(generateAiTxt({ scope: 'types', types: ['bogus'] }), /Disallow: \/\n$/);
  });
});

describe('generateMetaTags', () => {
  test('emits noai and noimageai with an honest explanation', () => {
    const html = generateMetaTags();
    assert.match(html, /<meta name="robots" content="noai, noimageai">/);
    assert.match(html, /X-Robots-Tag: noai, noimageai/);
    assert.match(html, /do not/);
    assert.match(generateMetaTags({ images: false }), /content="noai">/);
  });
});

describe('generateTdmRep', () => {
  test('reserves TDM rights for the whole site', () => {
    const out = generateTdmRep();
    assert.equal(out.path, '/.well-known/tdmrep.json');
    assert.deepEqual(JSON.parse(out.json), [{ location: '/', 'tdm-reservation': 1 }]);
    assert.match(out.headers, /^tdm-reservation: 1$/m);
    assert.doesNotMatch(out.headers, /tdm-policy/);
    assert.match(out.meta, /<meta name="tdm-reservation" content="1">/);
  });

  test('adds the policy URL everywhere when given', () => {
    const out = generateTdmRep({ policyUrl: 'https://example.com/tdm-policy.json', location: '/images/' });
    assert.deepEqual(JSON.parse(out.json), [
      { location: '/images/', 'tdm-reservation': 1, 'tdm-policy': 'https://example.com/tdm-policy.json' },
    ]);
    assert.match(out.headers, /^tdm-policy: https:\/\/example\.com\/tdm-policy\.json$/m);
    assert.match(out.meta, /<meta name="tdm-policy" content="https:\/\/example\.com\/tdm-policy\.json">/);
  });

  test('rejects non-https or invalid policy URLs and bad locations', () => {
    assert.throws(() => generateTdmRep({ policyUrl: 'http://example.com/p' }), TypeError);
    assert.throws(() => generateTdmRep({ policyUrl: 'not a url' }), TypeError);
    assert.equal(JSON.parse(generateTdmRep({ location: 'no-slash' }).json)[0].location, '/');
  });
});
