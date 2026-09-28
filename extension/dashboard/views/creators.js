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
  { id: 'training', label: 'Block AI training, keep search', desc: 'Stops crawlers that collect training data. AI search and assistants can still find and cite you.' },
  { id: 'all-ai', label: 'Block all AI', desc: 'Stops every known AI crawler, including AI search and assistants fetching pages for users.' },
  { id: 'custom', label: 'Custom', desc: 'Choose crawlers one by one.' },
];

const PURPOSE_LABELS = {
  training: { label: 'AI training', tone: 'bad' },
  search: { label: 'AI search', tone: 'info' },
  'user-triggered': { label: 'Fetches for users', tone: 'neutral' },
  mixed: { label: 'Mixed use', tone: 'warn' },
};

const RESPECTS = { true: 'Yes', false: 'No', unknown: 'Unknown' };

const cr = { preset: 'training', selected: null, tab: 'robots', policyUrl: '' };

export function title() {
  return 'For creators';
}

function initSelected(crawlers) {
  if (cr.selected) return;
  cr.selected = new Set(crawlers.filter((c) => c.purpose === 'training' || c.purpose === 'mixed').map((c) => c.token));
}

function asText(out) {
  if (typeof out === 'string') return out;
  if (out && typeof out === 'object') {
    return Object.entries(out)
      .filter(([, v]) => typeof v === 'string')
      .map(([k, v]) => (Object.keys(out).length > 1 ? `# ${k}\n${v}` : v))
      .join('\n\n');
  }
  return '';
}

function robotsOptions(crawlers) {
  return {
    crawlers,
    block: cr.preset,
    selectedTokens: [...cr.selected],
    keepSearch: cr.preset === 'training',
  };
}

/** Tokens disallowed site-wide in a robots.txt, to show per-crawler state. */
function blockedTokens(robotsTxt) {
  const blocked = new Set();
  let agents = [];
  let inRules = false;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [k, ...rest] = line.split(':');
    const key = k.trim().toLowerCase();
    const value = rest.join(':').trim();
    if (key === 'user-agent') {
      if (inRules) {
        agents = [];
        inRules = false;
      }
      agents.push(value.toLowerCase());
    } else {
      inRules = true;
      if (key === 'disallow' && value === '/') agents.forEach((a) => blocked.add(a));
    }
  }
  return blocked;
}

function outputs(crawlers) {
  const opts = robotsOptions(crawlers);
  const safe = (fn, ...args) => {
    try {
      return asText(fn?.(...args));
    } catch (err) {
      return `# Couldn’t generate: ${err.message}`;
    }
  };
  return {
    robots: {
      label: 'robots.txt',
      file: 'robots.txt',
      where: 'Save as robots.txt at the root of your site, e.g. https://example.com/robots.txt. If you already have one, add these lines to it.',
      text: safe(robotsLib.generateRobotsTxt, opts),
    },
    ai: {
      label: 'ai.txt',
      file: 'ai.txt',
      where: 'Save as ai.txt next to robots.txt. A newer convention some AI companies read in addition to robots.txt.',
      text: safe(robotsLib.generateAiTxt, opts),
    },
    meta: {
      label: 'Meta tags',
      file: 'notrain-meta-tags.html',
      where: 'Paste inside the <head> of every page. Some image and art platforms read these to exclude your work.',
      text: safe(robotsLib.generateMetaTags, opts),
    },
    tdm: {
      label: 'TDMRep',
      file: 'tdmrep.json',
      where: 'The W3C TDM Reservation Protocol, recognised in the EU. Serve the JSON at /.well-known/tdmrep.json, or send the HTTP header on every response.',
      text: safe(robotsLib.generateTdmRep, { policyUrl: cr.policyUrl || undefined }),
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
          h('span', { class: 'nt-choice__body' }, h('span', { class: 'nt-choice__title' }, p.label), h('span', { class: 'nt-choice__desc' }, p.desc)),
        ),
      ),
    ),
  );
}

function crawlerTable(crawlers, blocked, onChange) {
  const custom = cr.preset === 'custom';
  return h(
    'div',
    { class: 'nt-table-wrap c-table' },
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
          const isBlocked = custom ? cr.selected.has(c.token) : blocked.has(c.token.toLowerCase()) || blocked.has('*');
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
                : h('span', { class: ['nt-pill', isBlocked ? 'nt-pill--bad' : 'nt-pill--good'] }, isBlocked ? 'Blocked' : 'Allowed'),
            ),
            h(
              'td',
              null,
              h('span', { class: 'c-token nt-mono' }, c.token),
              c.notes && h('span', { class: 'c-notes' }, c.notes),
            ),
            h('td', null, c.docsUrl ? extLink(c.docsUrl, c.operator, { class: 'nt-link' }) : c.operator),
            h('td', null, h('span', { class: ['nt-pill', 'nt-pill--plain', `nt-pill--${purpose.tone}`] }, purpose.label)),
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
  const panel = h(
    'div',
    { class: 'c-panel', role: 'tabpanel', id: `panel-${cr.tab}`, 'aria-labelledby': `tab-${cr.tab}`, tabindex: '-1' },
    h('p', { class: 'c-where' }, cur.where),
    cr.tab === 'tdm' &&
      textField({
        id: 'tdm-policy',
        label: 'Licensing policy URL (optional)',
        hint: 'A page explaining how AI companies can license your content, if you offer that.',
        value: cr.policyUrl,
        type: 'url',
        placeholder: 'https://example.com/ai-licensing',
        onInput: (e) => {
          cr.policyUrl = e.currentTarget.value.trim();
          const code = document.querySelector('.c-output');
          if (code) code.value = outputs(currentCrawlers).tdm.text;
        },
      }),
    h('textarea', {
      class: 'nt-code c-output',
      readonly: true,
      rows: Math.min(22, Math.max(6, cur.text.split('\n').length + 1)),
      'aria-label': `${cur.label} output`,
      'data-testid': 'creator-output',
      spellcheck: 'false',
      value: cur.text,
    }),
    h(
      'div',
      { class: 'nt-btn-row' },
      button('Copy', {
        variant: 'primary',
        iconName: 'copy',
        testid: 'creator-copy',
        onClick: () => copyText(document.querySelector('.c-output')?.value ?? cur.text, cur.label),
      }),
      button('Download', {
        variant: 'secondary',
        iconName: 'download',
        testid: 'creator-download',
        ariaLabel: `Download ${cur.file}`,
        onClick: () => downloadText(cur.file, document.querySelector('.c-output')?.value ?? cur.text),
      }),
    ),
  );
  return h('section', { class: 'nt-card c-outputs', 'aria-label': 'Generated files' }, tablist, panel);
}

let currentCrawlers = [];

export function render(ctx) {
  const { state } = ctx;
  const header = pageHeader({
    title: 'For creators',
    subtitle: 'Run a website, blog or portfolio? Tell AI crawlers not to use your work for training. Pick a preset, then copy the files to your site.',
  });
  const crawlers = state.registry.crawlers ?? [];
  currentCrawlers = crawlers;

  if (!robotsLib) {
    if (robotsError) {
      return [header, h('div', { class: 'nt-card' }, emptyState({ iconName: 'alertCircle', title: 'The generator isn’t available', text: 'It couldn’t be loaded in this build.' }))];
    }
    robotsReady.then(() => ctx.rerender());
    return [header, h('div', { class: 'nt-card', style: { padding: '24px' } }, h('span', { class: 'nt-skeleton nt-skeleton--title' }))];
  }
  if (!crawlers.length) {
    return [header, h('div', { class: 'nt-card' }, emptyState({ iconName: 'bot', title: 'No crawler list yet', text: 'The list of AI crawlers hasn’t loaded. Check for updates in Settings.' }))];
  }

  initSelected(crawlers);
  const root = h('div', { class: 'c-wrap' });
  const draw = () => {
    const out = outputs(crawlers);
    const blocked = blockedTokens(out.robots.text);
    const active = document.activeElement?.id;
    mount(
      root,
      h('section', { class: 'nt-card c-config', 'aria-label': 'Choose crawlers' }, presetPicker(draw), crawlerTable(crawlers, blocked, draw)),
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
