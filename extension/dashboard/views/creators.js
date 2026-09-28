// #/creators: robots.txt / ai.txt / meta tags / TDMRep generator for site owners.

import { h, mount, extLink } from '../../shared/dom.js';
import { icon } from '../../shared/icons.js';
import { pageHeader, emptyState, button, copyText, downloadText, textField } from '../common.js';

let robotsLib = null;
let robotsError = null;
const robotsReady = import('../../lib/robots.js')
  .then((m) => {
    robotsLib = m;
  })
  .catch((err) => {
    robotsError = err;
  });

const PRESETS = [
  {
    id: 'training',
    label: 'Block AI training, keep search',
    desc: 'Stops crawlers that collect training data. AI search and assistants can still find and cite you.',
  },
  {
    id: 'all-ai',
    label: 'Block all AI',
    desc: 'Also stops AI assistants fetching your pages for users. Regular search engines stay allowed.',
  },
  { id: 'custom', label: 'Custom', desc: 'Choose crawlers one by one.' },
];

const PURPOSE_LABELS = {
  training: { label: 'AI training', tone: 'bad' },
  search: { label: 'AI search', tone: 'info' },
  'user-triggered': { label: 'Fetches for users', tone: 'neutral' },
  mixed: { label: 'Mixed use', tone: 'warn' },
};

const RESPECTS = { true: 'Yes', false: 'No', unknown: 'Unknown' };

const cr = {
  preset: 'training',
  keepSearch: true,
  selected: null,
  tab: 'robots',
  policyUrl: '',
  policyError: '',
};

export function title() {
  return 'For creators';
}

function initSelected(crawlers) {
  if (cr.selected) return;
  cr.selected = new Set(
    crawlers.filter((c) => c.purpose === 'training' || c.purpose === 'mixed').map((c) => c.token),
  );
}

function robotsOptions(crawlers) {
  return {
    crawlers,
    block: cr.preset,
    selectedTokens: [...cr.selected],
    keepSearch: cr.preset === 'all-ai' ? cr.keepSearch : true,
  };
}

/** Tokens the current configuration blocks (lower-case). */
function blockedTokens(crawlers) {
  try {
    return new Set(robotsLib.selectCrawlers(robotsOptions(crawlers)).map((c) => c.token.toLowerCase()));
  } catch {
    return new Set();
  }
}

function tdmBlocks() {
  cr.policyError = '';
  let out;
  try {
    out = robotsLib.generateTdmRep({ policyUrl: cr.policyUrl || undefined });
  } catch (err) {
    cr.policyError = 'Enter a full https:// address, or leave it empty.';
    out = robotsLib.generateTdmRep({});
  }
  const path = out?.path ?? '/.well-known/tdmrep.json';
  return [
    { label: `File: ${path}`, file: 'tdmrep.json', text: out?.json ?? '', key: 'tdm-json' },
    {
      label: 'Or send these HTTP headers',
      file: 'tdm-headers.txt',
      text: out?.headers ?? '',
      key: 'tdm-headers',
    },
    out?.meta
      ? { label: 'Or add this to each page', file: 'tdm-meta.html', text: out.meta, key: 'tdm-meta' }
      : null,
  ].filter((b) => b && b.text);
}

function outputs(crawlers) {
  const safe = (fn, arg) => {
    try {
      const out = fn?.(arg);
      return typeof out === 'string' ? out : '';
    } catch (err) {
      return `# Couldn’t generate: ${err.message}`;
    }
  };
  return {
    robots: {
      label: 'robots.txt',
      where:
        'Add these lines to robots.txt at the root of your site (for example https://example.com/robots.txt), next to any rules you already have.',
      blocks: [
        {
          label: 'robots.txt',
          file: 'robots.txt',
          text: safe(robotsLib.generateRobotsTxt, robotsOptions(crawlers)),
          key: 'robots',
        },
      ],
    },
    ai: {
      label: 'ai.txt',
      where:
        'Save as ai.txt next to robots.txt. A newer convention, read by Spawning’s tools and the datasets that honour it.',
      blocks: [
        { label: 'ai.txt', file: 'ai.txt', text: safe(robotsLib.generateAiTxt, { scope: 'all' }), key: 'ai' },
      ],
    },
    meta: {
      label: 'Meta tags',
      where:
        'Paste inside the <head> of every page. Some art and image platforms read these to exclude your work.',
      blocks: [
        {
          label: 'HTML',
          file: 'notrain-meta-tags.html',
          text: safe(robotsLib.generateMetaTags, { images: true }),
          key: 'meta',
        },
      ],
    },
    tdm: {
      label: 'TDMRep',
      where:
        'The W3C TDM Reservation Protocol: a machine-readable opt-out from text and data mining under EU law (Directive 2019/790, Article 4).',
      blocks: tdmBlocks(),
    },
  };
}

function presetPicker(onChange) {
  return h(
    'fieldset',
    { class: 'c-presets' },
    h('legend', { class: 'nt-label' }, 'What do you want to block?'),
    h(
      'div',
      { class: 'c-presets__grid' },
      PRESETS.map((p) =>
        h(
          'label',
          { class: 'nt-choice' },
          h('input', {
            type: 'radio',
            name: 'preset',
            value: p.id,
            checked: cr.preset === p.id,
            'data-testid': `preset-${p.id}`,
            onChange: () => {
              cr.preset = p.id;
              onChange();
            },
          }),
          h(
            'span',
            { class: 'nt-choice__body' },
            h('span', { class: 'nt-choice__title' }, p.label),
            h('span', { class: 'nt-choice__desc' }, p.desc),
          ),
        ),
      ),
    ),
    cr.preset === 'all-ai' &&
      h(
        'label',
        { class: 'nt-check c-keep' },
        h('input', {
          type: 'checkbox',
          id: 'keep-search',
          checked: cr.keepSearch,
          'data-testid': 'keep-search',
          onChange: (e) => {
            cr.keepSearch = e.currentTarget.checked;
            onChange();
          },
        }),
        'Still allow AI search crawlers, so your pages can appear in AI answers',
      ),
  );
}

function crawlerTable(crawlers, blocked, onChange) {
  const custom = cr.preset === 'custom';
  return h(
    'div',
    {
      class: 'nt-table-wrap c-table',
      tabindex: '0',
      role: 'region',
      'aria-label': 'AI crawlers (scrollable)',
    },
    h(
      'table',
      { class: 'nt-table', 'data-testid': 'crawler-table' },
      h('caption', { class: 'nt-visually-hidden' }, 'Known AI crawlers'),
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', { scope: 'col' }, custom ? 'Block' : 'Status'),
          h('th', { scope: 'col' }, 'Crawler'),
          h('th', { scope: 'col' }, 'Operator'),
          h('th', { scope: 'col' }, 'Purpose'),
          h('th', { scope: 'col' }, 'Follows robots.txt'),
        ),
      ),
      h(
        'tbody',
        null,
        crawlers.map((c) => {
          const purpose = PURPOSE_LABELS[c.purpose] ?? { label: c.purpose, tone: 'neutral' };
          const isBlocked = custom ? cr.selected.has(c.token) : blocked.has(c.token.toLowerCase());
          const id = `crawler-${c.token.replace(/[^a-z0-9]+/gi, '-')}`;
          return h(
            'tr',
            null,
            h(
              'td',
              null,
              custom
                ? h('input', {
                    type: 'checkbox',
                    id,
                    class: 'c-check',
                    checked: isBlocked,
                    'aria-label': `Block ${c.token}`,
                    'data-testid': 'crawler-check',
                    onChange: (e) => {
                      if (e.currentTarget.checked) cr.selected.add(c.token);
                      else cr.selected.delete(c.token);
                      onChange();
                    },
                  })
                : h(
                    'span',
                    { class: ['nt-pill', isBlocked ? 'nt-pill--bad' : 'nt-pill--good'] },
                    isBlocked ? 'Blocked' : 'Allowed',
                  ),
            ),
            h(
              'td',
              null,
              h('span', { class: 'c-token nt-mono' }, c.token),
              c.notes && h('span', { class: 'c-notes' }, c.notes),
            ),
            h('td', null, c.docsUrl ? extLink(c.docsUrl, c.operator, { class: 'nt-link' }) : c.operator),
            h(
              'td',
              null,
              h('span', { class: ['nt-pill', 'nt-pill--plain', `nt-pill--${purpose.tone}`] }, purpose.label),
            ),
            h('td', { class: 'c-respects' }, RESPECTS[String(c.respectsRobotsTxt)] ?? 'Unknown'),
          );
        }),
      ),
    ),
  );
}

function outputTabs(out, onTab) {
  const ids = Object.keys(out);
  const tablist = h(
    'div',
    {
      class: 'nt-tabs',
      role: 'tablist',
      'aria-label': 'Output format',
      onKeydown: (e) => {
        const i = ids.indexOf(cr.tab);
        let next = null;
        if (e.key === 'ArrowRight') next = ids[(i + 1) % ids.length];
        if (e.key === 'ArrowLeft') next = ids[(i - 1 + ids.length) % ids.length];
        if (e.key === 'Home') next = ids[0];
        if (e.key === 'End') next = ids[ids.length - 1];
        if (next) {
          e.preventDefault();
          cr.tab = next;
          onTab();
          document.getElementById(`tab-${next}`)?.focus();
        }
      },
    },
    ids.map((id) =>
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          class: 'nt-tab',
          id: `tab-${id}`,
          'aria-selected': String(cr.tab === id),
          'aria-controls': `panel-${id}`,
          tabindex: cr.tab === id ? '0' : '-1',
          'data-testid': `output-tab-${id}`,
          onClick: () => {
            cr.tab = id;
            onTab();
          },
        },
        out[id].label,
      ),
    ),
  );
  const cur = out[cr.tab];
  const codeBlock = (b, i) =>
    h(
      'div',
      { class: 'c-block' },
      cur.blocks.length > 1 && h('p', { class: 'c-block__label', id: `blk-${b.key}` }, b.label),
      h('textarea', {
        class: 'nt-code c-output',
        id: `out-${b.key}`,
        readonly: true,
        rows: Math.min(20, Math.max(4, b.text.split('\n').length + 1)),
        'aria-label': cur.blocks.length > 1 ? b.label : `${cur.label} output`,
        'data-testid': i === 0 ? 'creator-output' : `creator-output-${b.key}`,
        spellcheck: 'false',
        value: b.text,
      }),
      h(
        'div',
        { class: 'nt-btn-row' },
        button('Copy', {
          variant: i === 0 ? 'primary' : 'secondary',
          size: i === 0 ? undefined : 'sm',
          iconName: 'copy',
          testid: i === 0 ? 'creator-copy' : `creator-copy-${b.key}`,
          ariaLabel: `Copy ${b.label}`,
          onClick: () => copyText(b.text, b.label),
        }),
        button('Download', {
          variant: 'secondary',
          size: i === 0 ? undefined : 'sm',
          iconName: 'download',
          testid: i === 0 ? 'creator-download' : `creator-download-${b.key}`,
          ariaLabel: `Download ${b.file}`,
          onClick: () => downloadText(b.file, b.text),
        }),
      ),
    );
  const panel = h(
    'div',
    {
      class: 'c-panel',
      role: 'tabpanel',
      id: `panel-${cr.tab}`,
      'aria-labelledby': `tab-${cr.tab}`,
      tabindex: '-1',
    },
    h('p', { class: 'c-where' }, cur.where),
    cr.tab === 'tdm' &&
      h(
        'div',
        { class: 'c-policy' },
        textField({
          id: 'tdm-policy',
          label: 'Licensing policy URL (optional)',
          hint:
            cr.policyError ||
            'A page explaining how AI companies can license your content, if you offer that.',
          value: cr.policyUrl,
          type: 'url',
          placeholder: 'https://example.com/ai-licensing',
          onChange: (e) => {
            cr.policyUrl = e.currentTarget.value.trim();
            onTab();
          },
        }),
      ),
    cur.blocks.map(codeBlock),
  );
  return h('section', { class: 'nt-card c-outputs', 'aria-label': 'Generated files' }, tablist, panel);
}

export function render(ctx) {
  const { state } = ctx;
  const header = pageHeader({
    title: 'For creators',
    subtitle:
      'Run a website, blog or portfolio? Tell AI crawlers not to use your work for training. Pick a preset, then copy the files to your site.',
  });
  const crawlers = state.registry.crawlers ?? [];

  if (!robotsLib) {
    if (robotsError) {
      return [
        header,
        h(
          'div',
          { class: 'nt-card' },
          emptyState({
            iconName: 'alertCircle',
            title: 'The generator isn’t available',
            text: 'It couldn’t be loaded in this build.',
          }),
        ),
      ];
    }
    robotsReady.then(() => ctx.rerender());
    return [
      header,
      h(
        'div',
        { class: 'nt-card', style: { padding: '24px' } },
        h('span', { class: 'nt-skeleton nt-skeleton--title' }),
      ),
    ];
  }
  if (!crawlers.length) {
    return [
      header,
      h(
        'div',
        { class: 'nt-card' },
        emptyState({
          iconName: 'bot',
          title: 'No crawler list yet',
          text: 'The list of AI crawlers hasn’t loaded. Check for updates in Settings.',
        }),
      ),
    ];
  }

  initSelected(crawlers);
  const root = h('div', { class: 'c-wrap' });
  const draw = () => {
    const out = outputs(crawlers);
    const blocked = blockedTokens(crawlers);
    const active = document.activeElement?.id;
    mount(
      root,
      h(
        'section',
        { class: 'nt-card c-config', 'aria-label': 'Choose crawlers' },
        presetPicker(draw),
        crawlerTable(crawlers, blocked, draw),
      ),
      outputTabs(out, draw),
    );
    if (active) document.getElementById(active)?.focus();
  };
  draw();

  return [
    header,
    root,
    h(
      'div',
      { class: 'nt-callout nt-callout--neutral' },
      icon('info'),
      h(
        'div',
        { class: 'nt-callout__body' },
        h('p', { class: 'nt-callout__title' }, 'A request, not a lock'),
        h(
          'p',
          null,
          'robots.txt and these signals are voluntary. Reputable AI companies follow them; some crawlers don’t. They also don’t remove anything already collected. For stronger protection, add a licensing statement and use your platform’s own AI settings.',
        ),
      ),
    ),
  ];
}
