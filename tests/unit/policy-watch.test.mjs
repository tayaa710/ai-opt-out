import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  REPORT_LIMIT,
  SNAPSHOT_DIR,
  SUMMARY_MODEL,
  decodeEntities,
  diffLines,
  extractText,
  fetchPage,
  hashText,
  hunks,
  isAiRelevant,
  looksLikeChallenge,
  normalizeText,
  renderReport,
  safeMarkdown,
  snapshotFile,
  summarizeChange,
  watchPolicies,
} from '../../scripts/policy-watch.mjs';

const fixture = (name) =>
  readFileSync(new URL(`./fixtures/policy-watch/${name}.html`, import.meta.url), 'utf8');
const textOf = (name) => normalizeText(extractText(fixture(name)));

describe('extractText', () => {
  test('keeps the main content and drops scripts, navigation, banners, footers and hidden text', () => {
    const text = extractText(fixture('policy-v1'));
    assert.match(text, /We may use your conversations to train our AI models/);
    for (const noise of [
      'dataLayer',
      'font-family',
      'Pricing',
      'Accept all cookies',
      'Skip to content',
      'Related articles',
      'Hidden experiment',
      'All rights reserved',
    ]) {
      assert.ok(!text.includes(noise), `"${noise}" should be removed`);
    }
  });

  test('uses the whole body when there is no <main>', () => {
    const text = extractText('<body><nav>Menu</nav><div><p>Hello <b>world</b></p><p>Second</p></div></body>');
    assert.deepEqual(normalizeText(text), 'Hello world\nSecond\n');
  });

  test('collapses source whitespace like a browser and breaks lines at blocks', () => {
    const text = normalizeText(
      extractText('<main><p>one\n   two</p><ul><li>a</li><li>b</li></ul>c<br>d</main>'),
    );
    assert.equal(text, 'one two\na\nb\nc\nd\n');
  });

  test('tolerates malformed HTML', () => {
    const text = normalizeText(extractText('<main><p>open <div>nested</p> tail </main><p>outside'));
    assert.match(text, /open/);
    assert.match(text, /nested/);
  });
});

describe('decodeEntities', () => {
  test('decodes named and numeric entities and leaves unknown ones', () => {
    assert.equal(
      decodeEntities('&amp; &lt;b&gt; &quot;x&quot; &#39; &#x41; &rarr; &eacute; &unknown;'),
      '& <b> "x" \' A → é &unknown;',
    );
    assert.equal(decodeEntities('&#xFFFFFFF;'), '&#xFFFFFFF;');
  });
});

describe('normalizeText', () => {
  test('ignores noise: whitespace, quotes, copyright years, relative times, timestamps', () => {
    const a = normalizeText(
      'Policy\n\n“Quoted”  text\u00a0here\n© 2025 Example\nUpdated 3 days ago\nBuilt 2026-09-01T10:00:00Z\n',
    );
    const b = normalizeText(
      'Policy\n"Quoted" text here\n© 2026 Example\nUpdated over a week ago\nBuilt 2026-09-28T08:00:00.123Z\n',
    );
    assert.equal(a, b);
    assert.equal(a, 'Policy\n"Quoted" text here\nBuilt [timestamp]\n');
  });

  test('keeps "Last updated" dates, because they signal a real policy change', () => {
    assert.match(normalizeText('Last updated: March 3, 2026\n'), /Last updated: March 3, 2026/);
  });

  test('removes zero-width characters and consecutive duplicates', () => {
    assert.equal(normalizeText('a\u200bb\nsame\nsame\nother\n'), 'ab\nsame\nother\n');
    assert.equal(normalizeText('\n  \n'), '');
  });

  test('page chrome changes do not change the hash; policy changes do', () => {
    assert.equal(hashText(textOf('policy-v1')), hashText(textOf('policy-v1-noise')));
    assert.notEqual(hashText(textOf('policy-v1')), hashText(textOf('policy-v2')));
  });
});

describe('diffLines and hunks', () => {
  test('finds added and removed paragraphs', () => {
    const ops = diffLines(textOf('policy-v1').trim().split('\n'), textOf('policy-v2').trim().split('\n'));
    const added = ops.filter((o) => o.type === 'add').map((o) => o.line);
    const removed = ops.filter((o) => o.type === 'del').map((o) => o.line);
    assert.deepEqual(added, [
      'Last updated: September 20, 2026',
      'We use your conversations, including voice chats, to train our AI models by default. You can object in Settings → Data controls.',
    ]);
    assert.deepEqual(removed, [
      'Last updated: March 3, 2026',
      'We may use your conversations to train our AI models. You can opt out in Settings → Data controls.',
    ]);
    assert.ok(added.every((l) => !removed.includes(l)));
  });

  test('handles identical, empty and completely different inputs', () => {
    assert.ok(diffLines(['a', 'b'], ['a', 'b']).every((o) => o.type === 'same'));
    assert.deepEqual(diffLines([], ['x']), [{ type: 'add', line: 'x' }]);
    assert.deepEqual(diffLines(['x'], []), [{ type: 'del', line: 'x' }]);
    const ops = diffLines(['a', 'b', 'c'], ['a', 'x', 'c']);
    assert.deepEqual(
      ops.map((o) => o.type),
      ['same', 'del', 'add', 'same'],
    );
  });

  test('falls back to a set difference for very large inputs', () => {
    const a = Array.from({ length: 2100 }, (_, i) => `line ${i}`);
    const b = [...a.slice(0, 1000).reverse(), 'new line', ...a.slice(1000)].reverse();
    const ops = diffLines(a, b);
    assert.deepEqual(
      ops.filter((o) => o.type === 'add').map((o) => o.line),
      ['new line'],
    );
  });

  test('hunks keep one line of context', () => {
    const ops = diffLines(['1', '2', '3', '4', '5', '6', '7'], ['1', '2', 'X', '4', '5', '6', 'Y']);
    const h = hunks(ops);
    assert.equal(h.length, 2);
    assert.deepEqual(
      h[0].map((o) => o.line),
      ['2', '3', 'X', '4'],
    );
  });

  test('isAiRelevant spots training-related paragraphs', () => {
    assert.ok(isAiRelevant('We use your content to train our AI models.'));
    assert.ok(isAiRelevant('You can opt out at any time.'));
    assert.ok(isAiRelevant('We rely on legitimate interests.'));
    assert.ok(!isAiRelevant('Contact us at privacy@example.com.'));
  });
});

describe('fetching', () => {
  test('recognises bot-protection pages', () => {
    assert.ok(looksLikeChallenge(fixture('challenge'), 200));
    assert.ok(looksLikeChallenge('<html></html>', 403));
    assert.ok(!looksLikeChallenge(fixture('policy-v1'), 200));
  });

  test('fetchPage sends a descriptive User-Agent and returns the HTML', async () => {
    let seen;
    const fetchImpl = async (url, init) => {
      seen = init;
      return new Response(fixture('policy-v1'), { status: 200, headers: { 'content-type': 'text/html' } });
    };
    const page = await fetchPage('https://example.com/privacy', { fetchImpl });
    assert.match(
      seen.headers['user-agent'],
      /NoTrainPolicyWatch\/1\.0 \(\+https:\/\/github\.com\/tayaa710\/ai-opt-out\)/,
    );
    assert.ok(seen.signal instanceof AbortSignal);
    assert.match(page.html, /Privacy/);
  });

  test('fetchPage retries network errors once, but not HTTP errors', async () => {
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return new Response('<p>ok</p>', { headers: { 'content-type': 'text/html' } });
    };
    await fetchPage('https://example.com', { fetchImpl: flaky });
    assert.equal(calls, 2);

    calls = 0;
    const notFound = async () => {
      calls += 1;
      return new Response('nope', { status: 404 });
    };
    await assert.rejects(fetchPage('https://example.com', { fetchImpl: notFound }), /HTTP 404/);
    assert.equal(calls, 1);

    const pdf = async () => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } });
    await assert.rejects(fetchPage('https://example.com', { fetchImpl: pdf }), /unexpected content type/);
  });
});

describe('snapshots', () => {
  test('snapshotFile is stable, readable and path-safe', () => {
    const f = snapshotFile('chatgpt', 'https://openai.com/policies/privacy-policy/?x=../../etc');
    assert.equal(f, snapshotFile('chatgpt', 'https://openai.com/policies/privacy-policy/?x=../../etc'));
    assert.match(f, /^chatgpt\/openai-com-policies-privacy-policy-[0-9a-f]{8}\.txt$/);
    assert.notEqual(f, snapshotFile('chatgpt', 'https://openai.com/policies/privacy-policy/'));
  });
});

describe('watchPolicies (temp dir, fake network)', () => {
  let root;
  const service = {
    id: 'example',
    name: 'Example AI',
    company: 'Example Corp',
    summary: 'Example AI trains on your chats unless you opt out.',
    training: { trainsOnUserData: 'yes' },
    optOuts: [{ title: 'Turn off training', type: 'toggle', regions: ['ALL'] }],
    policyUrls: ['https://example.com/privacy', 'https://example.com/help'],
  };
  let pages;
  const fetchImpl = async (url) => {
    const page = pages[url];
    if (page instanceof Error) throw page;
    return new Response(page, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
  const run = (opts = {}) =>
    watchPolicies({
      root,
      services: [service],
      fetchImpl,
      summarize: false,
      minTextChars: 100,
      now: new Date('2026-09-28T00:00:00Z'),
      ...opts,
    });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'notrain-watch-'));
    pages = {
      'https://example.com/privacy': fixture('policy-v1'),
      'https://example.com/help': fixture('policy-v1-noise'),
    };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('first run writes baselines and an index', async () => {
    const res = await run();
    assert.deepEqual(
      res.results.map((r) => r.status),
      ['new', 'new'],
    );
    const index = JSON.parse(await readFile(path.join(root, SNAPSHOT_DIR, 'index.json'), 'utf8'));
    assert.deepEqual(Object.keys(index), ['https://example.com/help', 'https://example.com/privacy']);
    const entry = index['https://example.com/privacy'];
    assert.deepEqual(Object.keys(entry), ['serviceId', 'file', 'hash', 'lastChanged']);
    const snap = await readFile(path.join(root, SNAPSHOT_DIR, entry.file), 'utf8');
    assert.equal(hashText(snap), entry.hash);
    assert.match(renderReport(res), /## New baselines/);
  });

  test('noise-only changes are "unchanged" and do not rewrite anything', async () => {
    await run();
    const before = await readFile(path.join(root, SNAPSHOT_DIR, 'index.json'), 'utf8');
    pages['https://example.com/privacy'] = fixture('policy-v1-noise');
    const res = await run({ now: new Date('2026-10-05T00:00:00Z') });
    assert.deepEqual(
      res.results.map((r) => r.status),
      ['unchanged', 'unchanged'],
    );
    assert.equal(await readFile(path.join(root, SNAPSHOT_DIR, 'index.json'), 'utf8'), before);
  });

  test('real changes are reported with the changed paragraphs and snapshots are updated', async () => {
    await run();
    pages['https://example.com/privacy'] = fixture('policy-v2');
    const res = await run({ now: new Date('2026-10-05T00:00:00Z') });
    const changed = res.results.find((r) => r.status === 'changed');
    assert.equal(changed.url, 'https://example.com/privacy');
    assert.equal(changed.added.length, 2);
    assert.equal(changed.removed.length, 2);
    const index = JSON.parse(await readFile(path.join(root, SNAPSHOT_DIR, 'index.json'), 'utf8'));
    assert.equal(index['https://example.com/privacy'].lastChanged, '2026-10-05');
    assert.equal(index['https://example.com/help'].lastChanged, '2026-09-28');
    const report = renderReport(res);
    assert.match(report, /\*\*1 changed\*\*/);
    assert.match(report, /### Example AI \(`example`\)/);
    assert.match(report, /\*\*2 mention AI training, models or opting out\*\*/);
    assert.match(
      report,
      /\n\+ We use your conversations, including voice chats, to train our AI models by default\./,
    );
    assert.match(report, /\n- We may use your conversations to train our AI models\./);
    assert.match(report, /blob\/main\/registry\/services\/example\.json/);
  });

  test('fetch failures and JavaScript-only pages keep the old snapshot', async () => {
    await run();
    const before = await readFile(path.join(root, SNAPSHOT_DIR, 'index.json'), 'utf8');
    pages['https://example.com/privacy'] = new TypeError('fetch failed');
    pages['https://example.com/help'] = fixture('thin');
    const res = await run();
    assert.deepEqual(
      res.results.map((r) => r.status),
      ['error', 'thin'],
    );
    assert.equal(await readFile(path.join(root, SNAPSHOT_DIR, 'index.json'), 'utf8'), before);
    assert.match(renderReport(res), /## Could not check[\s\S]*fetch failed[\s\S]*may need JavaScript/);
  });

  test('--dry-run writes nothing', async () => {
    const res = await run({ dryRun: true });
    assert.deepEqual(
      res.results.map((r) => r.status),
      ['new', 'new'],
    );
    await assert.rejects(readdir(path.join(root, SNAPSHOT_DIR)));
  });

  test('--prune removes snapshots for URLs no longer in the registry', async () => {
    await run();
    const trimmed = { ...service, policyUrls: ['https://example.com/privacy'] };
    const res = await watchPolicies({
      root,
      services: [trimmed],
      fetchImpl,
      summarize: false,
      minTextChars: 100,
      prune: true,
    });
    assert.deepEqual(res.stale, ['https://example.com/help']);
    const index = JSON.parse(await readFile(path.join(root, SNAPSHOT_DIR, 'index.json'), 'utf8'));
    assert.deepEqual(Object.keys(index), ['https://example.com/privacy']);
  });

  test('uses the optional summary when available, and survives its failures', async () => {
    await run();
    pages['https://example.com/privacy'] = fixture('policy-v2');
    const calls = [];
    const summaryClient = {
      beta: {
        messages: {
          create: async (req) => {
            calls.push(req);
            return {
              model: req.model,
              stop_reason: 'end_turn',
              content: [
                {
                  type: 'text',
                  text: 'VERDICT: RELEVANT\n- Training is now **on by default** for @everyone <img src=x>.',
                },
              ],
            };
          },
        },
      },
    };
    const res = await run({ summarize: true, summaryClient });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, SUMMARY_MODEL);
    assert.deepEqual(calls[0].betas, ['server-side-fallback-2026-07-01']);
    assert.equal(calls[0].fallbacks, 'default');
    assert.match(calls[0].messages[0].content, /<added_paragraphs>[\s\S]*voice chats/);
    const report = renderReport(res);
    assert.match(report, /Claude's assessment: RELEVANT/);
    assert.match(report, /@\u200beveryone &lt;img/);
  });
});

describe('summarizeChange', () => {
  const change = {
    service: { name: 'X', company: 'Y', optOuts: [] },
    url: 'https://x.example',
    added: ['a'],
    removed: ['b'],
  };

  test('returns null without an API key or client', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      assert.equal(await summarizeChange(change), null);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  test('reports refusals, empty answers and API errors instead of throwing', async () => {
    const refusal = {
      beta: {
        messages: {
          create: async () => ({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] }),
        },
      },
    };
    assert.match((await summarizeChange(change, { client: refusal })).error, /declined.*cyber/);
    const empty = {
      beta: { messages: { create: async () => ({ stop_reason: 'max_tokens', content: [] }) } },
    };
    assert.match((await summarizeChange(change, { client: empty })).error, /empty response/);
    const failing = {
      beta: {
        messages: {
          create: async () => {
            throw Object.assign(new Error('overloaded'), { status: 529 });
          },
        },
      },
    };
    assert.match(
      (await summarizeChange(change, { client: failing })).error,
      /summary failed \(HTTP 529\): overloaded/,
    );
  });

  test('defaults the verdict to UNCLEAR when the model does not give one', async () => {
    const vague = {
      beta: {
        messages: {
          create: async () => ({
            model: 'm',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'Something changed.' }],
          }),
        },
      },
    };
    const res = await summarizeChange(change, { client: vague });
    assert.equal(res.verdict, 'UNCLEAR');
    assert.equal(res.text, 'Something changed.');
  });
});

describe('report safety', () => {
  test('safeMarkdown neutralises HTML and mentions', () => {
    assert.equal(
      safeMarkdown('<script>@octocat</script> a@b.com'),
      '&lt;script>@\u200boctocat&lt;/script> a@\u200bb.com',
    );
  });

  test('diff blocks use a fence longer than any backtick run in the page text', () => {
    const report = renderReport({
      date: '2026-09-28',
      stale: [],
      results: [
        {
          status: 'changed',
          serviceId: 's',
          serviceName: 'S',
          url: 'https://s.example',
          added: ['```` injected'],
          removed: [],
          hunks: [[{ type: 'add', line: '```` injected' }]],
        },
      ],
    });
    assert.match(report, /`````diff\n\+ ```` injected\n`````/);
  });

  test('long reports are shortened to fit a GitHub issue', () => {
    const results = Array.from({ length: 200 }, (_, i) => ({
      status: 'changed',
      serviceId: `s${i}`,
      serviceName: `Service ${i}`,
      url: `https://s${i}.example`,
      added: ['x'.repeat(500)],
      removed: [],
      hunks: [[{ type: 'add', line: 'x'.repeat(500) }]],
    }));
    const report = renderReport({ date: '2026-09-28', stale: [], results });
    assert.ok(report.length <= REPORT_LIMIT);
    assert.match(report, /report was shortened/);
  });
});
