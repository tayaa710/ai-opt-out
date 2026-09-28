// Synthetic registry data for unit tests (independent of the real registry,
// which research agents edit).

import { REAL_MANIFEST } from './chrome-mock.mjs';

export const TEST_MANIFEST = {
  ...REAL_MANIFEST,
  optional_host_permissions: ['https://chatgpt.com/*', 'https://*.example.org/*'],
};

const clone = (v) => structuredClone(v);

/** A script URL, assembled so linters do not mistake the test input for real use. */
export const SCRIPT_URL = ['javascript', 'alert(1)'].join(':');

export function toggleOptOut(overrides = {}) {
  return {
    id: 'improve-model-toggle',
    type: 'toggle',
    title: 'Turn off “Improve the model for everyone”',
    url: 'https://chatgpt.com/#settings/DataControls',
    regions: ['ALL'],
    effort: 'quick',
    steps: ['Open settings.', 'Turn it off.'],
    effect: 'Stops new conversations being used for training.',
    automation: {
      confidence: 'medium',
      hostPermissions: ['https://chatgpt.com/*'],
      loginIndicators: [{ role: 'button', text: ['Log in'] }],
      steps: [
        { action: 'waitFor', target: { text: ['Improve the model for everyone'] }, timeoutMs: 15000 },
        {
          action: 'setToggle',
          target: { role: 'switch', text: ['Improve the model for everyone'] },
          state: 'off',
          description: 'Turning it off',
        },
      ],
      verify: [
        { action: 'waitFor', target: { text: ['Improve the model for everyone'] } },
        {
          action: 'assertToggle',
          target: { role: 'switch', text: ['Improve the model for everyone'] },
          state: 'off',
        },
      ],
    },
    ...overrides,
  };
}

export function formOptOut(overrides = {}) {
  return {
    id: 'privacy-portal',
    type: 'form',
    title: 'Ask OpenAI not to train on your content',
    url: 'https://privacy.openai.com/',
    regions: ['ALL'],
    effort: 'moderate',
    steps: ['Open the portal.', 'Submit the request.'],
    effect: 'Records a request that OpenAI not train on your content.',
    ...overrides,
  };
}

export function makeService(overrides = {}) {
  return clone({
    id: 'chatgpt',
    name: 'ChatGPT',
    company: 'OpenAI',
    category: 'ai-assistant',
    brandColor: '#10a37f',
    domains: ['chatgpt.com', 'openai.com'],
    summary: 'Your ChatGPT conversations are used to train models unless you turn this off.',
    training: {
      trainsOnUserData: 'yes',
      defaultState: 'opted_in',
      dataTypes: ['chats', 'files'],
      details: 'Conversations may be used to improve models unless the setting is off.',
      retroactiveRemoval: false,
    },
    optOuts: [toggleOptOut(), formOptOut()],
    detection: { cookies: [{ url: 'https://chatgpt.com', name: 'session-token' }] },
    sources: [{ title: 'Data controls FAQ', url: 'https://help.openai.com/en/articles/7730893' }],
    lastVerified: '2026-09-01',
    policyVersion: 1,
    changelog: [
      { version: 1, date: '2026-09-01', summary: 'Added to the NoTrain registry.', severity: 'info' },
    ],
    ...overrides,
  });
}

/** A second service whose automation lives on a host the manifest covers via a wildcard. */
export function exampleService(overrides = {}) {
  return makeService({
    id: 'example',
    name: 'Example',
    company: 'Example Inc.',
    category: 'social',
    domains: ['example.org'],
    optOuts: [
      toggleOptOut({
        id: 'ai-toggle',
        url: 'https://app.example.org/settings/ai',
        automation: {
          confidence: 'high',
          hostPermissions: ['https://app.example.org/*'],
          steps: [{ action: 'setToggle', target: { role: 'switch', text: ['Use my data'] }, state: 'off' }],
          verify: [
            { action: 'assertToggle', target: { role: 'switch', text: ['Use my data'] }, state: 'off' },
          ],
        },
      }),
    ],
    detection: { cookies: [{ url: 'https://app.example.org', name: 'sid' }] },
    ...overrides,
  });
}

/** A service whose recipe asks for a host the manifest does NOT declare. */
export function rogueService() {
  return makeService({
    id: 'rogue',
    name: 'Rogue',
    domains: ['evil.test'],
    optOuts: [
      toggleOptOut({
        id: 'toggle',
        url: 'https://evil.test/settings',
        automation: {
          confidence: 'high',
          hostPermissions: ['https://evil.test/*'],
          steps: [{ action: 'setToggle', target: { role: 'switch' }, state: 'off' }],
        },
      }),
    ],
    detection: { cookies: [{ url: 'https://evil.test', name: 'sid' }] },
  });
}

export function makeRegistry(
  services = [makeService(), exampleService()],
  generatedAt = '2026-09-01T00:00:00.000Z',
) {
  return clone({ formatVersion: 1, generatedAt, services, crawlers: [] });
}

/** A later version of a service with a policy change. */
export function bumpPolicy(
  service,
  severity = 'warning',
  summary = 'Now trains on voice recordings by default.',
) {
  const next = clone(service);
  next.policyVersion = service.policyVersion + 1;
  next.changelog = [
    ...service.changelog,
    { version: next.policyVersion, date: '2026-09-20', summary, severity },
  ];
  return next;
}
