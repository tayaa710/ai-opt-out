# NoTrain architecture

NoTrain is a browser extension (Chrome MV3, Firefox build too) backed by an
open, community-maintained registry. It answers three questions for the user:

1. **Which services I use train AI on my data?** (registry + optional local account detection)
2. **How do I opt out?** (one-click automation where possible, guided steps otherwise, generated legal request letters)
3. **Did anything change?** (weekly registry sync → policy-change alerts; flip-back detection; re-check reminders)

Plus a creator tool (robots.txt / ai.txt / TDMRep generator) and a proposed
open standard, `/.well-known/ai-training-opt-out`.

## Principles (non-negotiable)

- **Privacy first.** Nothing about the user leaves the device. No analytics, no accounts, no servers.
  The only network request the extension makes on its own is fetching the public registry JSON.
- **Least privilege.** Zero host permissions at install. Site access is requested per service,
  at the moment the user clicks "Opt out for me", as an *optional* host permission.
  Cookie-based account detection is opt-in and drops the extra permissions afterwards.
- **No remote code.** The registry is data. Automation recipes are a small declarative DSL
  interpreted by the bundled engine (Chrome Web Store policy compliant).
- **The user is always in control.** Automation only runs after the user clicks, on a tab it opens,
  shows progress in an on-page panel, and can be stopped. Failures fall back to guided mode.
- **Honesty.** Opting out generally only affects the future. The UI says so. Automation is labelled
  with a confidence level. No dark patterns, no fear-mongering.
- **Accessible.** Keyboard navigable, visible focus, proper labels/roles, WCAG AA contrast, respects
  `prefers-reduced-motion` and `prefers-color-scheme`.
- **No build step for extension code.** Plain ES modules (extension pages + service worker) and classic
  scripts (content scripts). No frameworks, no runtime dependencies.

## Repository layout and ownership

| Path | What | Owner |
| --- | --- | --- |
| `registry/schema/service.schema.json` | JSON Schema for one service (source of truth) | lead |
| `registry/schema/crawlers.schema.json` | JSON Schema for `crawlers.json` | tooling |
| `registry/services/<id>.json` | One file per service | research |
| `registry/crawlers.json` | AI crawler user agents for the creator tool | research |
| `registry/dist/registry.json` | Compiled registry (generated, committed; fetched by installed extensions) | tooling (script) |
| `extension/manifest.json` | Chrome MV3 manifest (`optional_host_permissions` is synced by the build script) | core |
| `extension/_locales/**` | i18n messages | core |
| `extension/background/**` | Service worker (module) | core |
| `extension/lib/constants.js`, `region.js`, `status.js`, `api.js` | Shared contracts | lead (others may extend, never break) |
| `extension/lib/{storage,registry,registry-diff,registry-validate,detection,alerts,permissions,runner,wellknown}.js` | Background logic | core |
| `extension/lib/letters.js`, `extension/lib/robots.js` | Pure generators (letters, robots.txt etc.) | tooling |
| `extension/content/**` | In-page engine + overlay + passive check (classic scripts) | content |
| `extension/popup/**`, `extension/dashboard/**`, `extension/shared/**`, `extension/icons/**` | UI + design system | ui |
| `extension/data/registry.json` | Bundled copy of the compiled registry (generated) | tooling (script) |
| `scripts/**`, `package.json`, lint/format config, `.github/**` | Build, validate, package, policy watch, CI | tooling |
| `tests/unit/**` | `node --test` unit tests | whoever owns the module under test |
| `tests/e2e/**`, `tests/fixtures/**` | Playwright tests + mock settings pages | content (engine/overlay/fixtures), ui (pages), core (flows) |
| `spec/**`, `site/**`, `README.md`, `PRIVACY.md`, `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE`, `CHANGELOG.md`, `store/**` | Docs, landing page, store listing | tooling |

## Registry

Source files: `registry/services/<id>.json`, validated against `registry/schema/service.schema.json`.
Read that schema: it documents every field. Key ideas:

- `training` says whether/what/default. `optOuts[]` lists the ways out, each with a region list,
  deep link, human steps, a plain statement of the `effect`, and optionally an `automation` recipe.
- `policyVersion` + `changelog[]` drive user alerts. Bump `policyVersion` and add a changelog entry
  (with `severity`) whenever training behaviour or opt-out options materially change.
- `detection.cookies[]` lists cookies whose *presence* indicates a signed-in user.
- `sources[]` must cite first-party documentation wherever possible; `lastVerified` is the date a human
  (or research agent) last checked the entry against those sources.

### Compiled format (`registry/dist/registry.json`, `extension/data/registry.json`)

```json
{
  "formatVersion": 1,
  "generatedAt": "2026-09-28T00:00:00.000Z",
  "services": [ /* service entries, sorted by name, exactly as in the source files */ ],
  "crawlers": [ /* entries from registry/crawlers.json */ ]
}
```

`crawlers.json`: `{ "crawlers": [ { "token": "GPTBot", "operator": "OpenAI", "purpose": "training" | "search" | "user-triggered" | "mixed", "respectsRobotsTxt": true | false | "unknown", "docsUrl": "https://…", "notes": "…" } ] }`.

Build-time invariants (enforced by `scripts/build-registry.mjs`, which fails CI on violation):
schema-valid; `id` equals file name; unique ids; unique opt-out ids within a service; every
`automation.hostPermissions` pattern and every `detection.cookies[].url` origin is listed in
`extension/manifest.json` `optional_host_permissions` (the script rewrites that list from the
registry; `--check` mode only verifies); `changelog` contains an entry whose `version` equals
`policyVersion`; `lastVerified` not in the future.

### Automation DSL

Interpreted by `extension/content/engine.js`. Steps (see `$defs/step` in the schema):

| action | meaning |
| --- | --- |
| `waitFor` | wait (MutationObserver + polling, default 10 s) until `target` exists and is visible |
| `click` | click `target` (scroll into view first). `optional: true` → skip silently if absent |
| `setToggle` | find switch/checkbox `target`; if its state ≠ `state`, click it (or its label) and wait until the state flips (default 5 s) |
| `assertToggle` | read-only: pass if the toggle is in `state`, else outcome `mismatch` |
| `wait` | sleep `ms` |

**Target resolution** (`{ selector?, role?, text?, within? }`): start from `within`'s match (or the
document), collect candidates by `selector` if given, else by `role` (native elements and ARIA roles,
e.g. role `switch` = `[role=switch]`, and `checkbox` = `input[type=checkbox]`, `[role=checkbox]`), else
all interactive elements. Traverse open shadow roots. If `text` is given, keep candidates whose
accessible name (aria-label, aria-labelledby, `<label for>`, wrapping `<label>`, textContent) or whose
*row text* (nearest ancestor, up to 5 levels, whose text is ≤ 300 chars) contains any candidate string
(case-insensitive, whitespace-normalised). With no `role`/`selector` and only `text`, match the
smallest visible element whose own text contains the string. Prefer visible, then exact over
substring, then the shortest text. Never match hidden elements.

**Toggle state** = first defined of: `aria-checked`, `aria-pressed`, native `.checked`,
`data-state` (`checked|on|active` → on, `unchecked|off|inactive` → off). Unknown → `failed`.

**Outcomes**: `success`, `already`, `not_found`, `needs_login`, `failed`, `cancelled`, `mismatch`
(see `RUN_OUTCOMES` in `lib/constants.js`). `loginIndicators` are checked before the steps: if one is
found, the run ends with `needs_login`.

## Extension runtime

### Storage (`chrome.storage.local`, keys in `STORAGE_KEYS`)

```js
settings = {                    // defaults: DEFAULT_SETTINGS in lib/constants.js
  schemaVersion, onboarded, region,              // region: code from lib/region.js
  notifications: { policyChanges, flipBacks, reminders },
  reminderIntervalDays, autoSync, passiveChecks,
  profile: { fullName, email },                  // only used to fill letters; never sent anywhere
}
userState = {
  services: {
    [serviceId]: {
      tracked: boolean, source: 'manual'|'detected', addedAt: ISO,
      knownPolicyVersion: number,                // version the user last saw/acknowledged
      optOuts: {
        [optOutId]: { status: OPT_OUT_STATUS, method: 'auto'|'guided'|'manual'|'letter',
                      updatedAt: ISO, verifiedAt: ISO|null, lastOutcome?: RUN_OUTCOMES, note?: string }
      }
    }
  }
}
registry     = compiled registry (validated). Bundled copy is used until a newer remote one is fetched.
registryMeta = { source: 'bundled'|'remote', generatedAt, lastSyncAt, lastSyncStatus: 'ok'|'unchanged'|'error', lastError? }
alerts  = [{ id, kind: ALERT_KINDS, serviceId, optOutId?, severity: 'info'|'warning'|'critical',
             title, body, createdAt, read: false, dismissed: false }]   // newest first, capped ALERTS_LIMIT
history = [{ id, at, serviceId, optOutId, action: 'auto'|'guided'|'manual'|'letter'|'verify'|'passive',
             outcome, detail? }]                                          // newest first, capped HISTORY_LIMIT
```

When a service becomes tracked, `knownPolicyVersion` is set to its current `policyVersion` (so the user
is only alerted about *future* changes).

### Messaging (UI → background)

Request: `{ type, ...payload }` via `chrome.runtime.sendMessage`. Response: `{ ok: true, data }` or
`{ ok: false, error: string }`. Client wrapper: `extension/lib/api.js`. UI pages re-render on
`chrome.storage.onChanged` (`onStateChange` in api.js) rather than on bespoke broadcasts.

| type | payload | data |
| --- | --- | --- |
| `getState` | – | `{ registry, registryMeta, settings, userState, alerts, history }` (history: latest 100) |
| `updateSettings` | `{ patch }` (deep-merged; `profile`/`notifications` merged one level) | `settings` |
| `trackServices` | `{ serviceIds, tracked, source }` | `userState` |
| `setOptOutStatus` | `{ serviceId, optOutId, status, method, note? }` | `userState` (+ history entry) |
| `acknowledgePolicy` | `{ serviceId }` | `userState` (and marks related policy alerts read) |
| `runOptOut` | `{ serviceId, optOutId, mode: 'auto'|'guided'|'verify' }` | `{ runId, tabId, injected: boolean, reason? }` |
| `detectAccounts` | – | `{ detected: serviceId[], checked: number }` |
| `syncRegistry` | `{ force }` | `registryMeta` |
| `markAlert` | `{ id, patch: { read?, dismissed? } }` | `alerts` |
| `markAllAlertsRead` | – | `alerts` |
| `recordLetter` | `{ serviceId, optOutId }` | `userState` (status `sent`, method `letter`) |
| `probeWellKnown` | `{ tabId }` | `{ found: boolean, url, document?: object, error? }` |
| `exportData` | – | JSON-serialisable backup `{ app: 'NoTrain', exportedAt, settings, userState, alerts, history }` |
| `importData` | `{ data }` | `{ settings, userState }` (validates before writing) |
| `resetAll` | – | `true` (clears storage, restores defaults, keeps bundled registry) |

Permissions: `chrome.permissions.request` must run in a click handler of an extension page. The UI
requests the opt-out's `automation.hostPermissions` (and for detection `cookies` + all detection
origins) **before** sending `runOptOut` / `detectAccounts`. The background never requests; if a
permission is missing, `runOptOut` still opens the tab and returns `injected: false, reason: 'no_permission'`
so the UI can show guided steps itself. Popups may close when a permission prompt opens, so the popup
routes permission-requiring actions to the dashboard (`dashboard.html#/service/<id>?run=<optOutId>&mode=auto`)
unless the permission is already granted.

### Opt-out run flow (`runOptOut`)

1. Look up service/opt-out; `mode` must be allowed (`auto`/`verify` need `automation`).
2. Open a new tab at `optOut.url` (focus its window), wait for `status: complete`.
3. If the host permission for `automation.hostPermissions` is granted (and the tab's URL still
   matches), inject `content/engine.js` then `content/overlay.js` via `chrome.scripting.executeScript`,
   then call `NoTrainOverlay.start(config)` with
   `{ runId, mode, service: { id, name, company }, optOut: { id, title, steps, effect, automation } }`.
   Guided mode also injects when permitted (so targets can be highlighted); otherwise the UI shows the
   steps.
4. Content scripts report back with `chrome.runtime.sendMessage`:
   - `{ type: 'runProgress', runId, stepIndex, total, description }`
   - `{ type: 'runResult', runId, serviceId, optOutId, mode, outcome, message? }`
   - `{ type: 'guidedDone', runId, serviceId, optOutId }` (user clicked "I've done it")
   - `{ type: 'passiveCheckResult', serviceId, optOutId, state: 'on'|'off'|'unknown' }`
   - `{ type: 'getPassiveChecks', url }` → `{ checks: [{ serviceId, optOutId, verify }] }`
5. Background updates `userState` + `history`:
   `success`/`already` → status `done` (method `auto`, `verifiedAt` now);
   `mismatch` → `needs_attention` + `flip_back` alert;
   `needs_login`/`not_found`/`failed` → keep status, store `lastOutcome`, overlay switches to guided.
   `guidedDone` → status `done`, method `guided`.

### Monitoring

- `chrome.alarms` `ALARMS.registrySync` weekly (and on startup if stale): fetch `REMOTE_REGISTRY_URL`
  (CORS-enabled; no host permission needed), validate (`lib/registry-validate.js`: structural checks,
  drop invalid services, reject if `formatVersion` unsupported), and replace the cache only if
  `generatedAt` is newer. Diff (`lib/registry-diff.js`) against the previous registry: for each
  *tracked* service whose `policyVersion` increased, create a `policy_change` alert from the new
  changelog entries (max severity); for `warning`/`critical`, show a system notification if enabled.
  New services → one grouped `new_service` info alert.
- `ALARMS.reminders` daily: for opt-outs with status `done` whose `verifiedAt` (or `updatedAt`) is older
  than `settings.reminderIntervalDays`, create one `reminder` alert per service (deduplicated).
- Passive flip-back checks: for tracked services with a `done` toggle opt-out that has `verify` steps and
  a granted host permission, register a content script (`chrome.scripting.registerContentScripts`,
  id `notrain-passive-<serviceId>`) with `content/engine.js` + `content/passive-check.js`. It asks the
  background for relevant checks, runs **only read-only** `assertToggle` targets (no clicks) for up to
  20 s, and reports. Background re-syncs registrations on install/startup, permission changes and state
  changes. `state: 'on'` for a toggle that should be off → `needs_attention` + `flip_back` alert +
  notification. `state: 'off'` → refresh `verifiedAt`.
- Badge: number of services with status `needs_attention` plus unread warning/critical alerts
  (`chrome.action.setBadgeText`), cleared when zero.
- Notification click → open the dashboard at the relevant service.

### Account detection (opt-in)

UI requests `cookies` + the detection origins, then sends `detectAccounts`. Background checks
`chrome.cookies.get({ url, name })` for each `detection.cookies` entry of every service (presence only;
values are never read into storage), marks found services tracked (`source: 'detected'`), then removes
the `cookies` permission and any detection origins that were not granted before detection started.

### `/.well-known/ai-training-opt-out` probe

The popup (opened by the user → `activeTab`) sends `probeWellKnown` with the tab id. Background uses
`chrome.scripting.executeScript` in that tab to `fetch('/.well-known/ai-training-opt-out')` same-origin
(3 s timeout, JSON ≤ 64 KB, validated against the spec in `spec/`), returning the document if present.

## UI

- **Popup** (`popup/popup.html`, 380 px wide): brand header; protection summary (N of M tracked services
  opted out, attention count); "you're on <service>" card when the active tab matches a registry service
  (or a well-known document is found); list of tracked services by urgency with status chips and a
  primary action; empty state → "Set up NoTrain" (opens onboarding); footer link to the dashboard.
- **Dashboard** (`dashboard/dashboard.html`, hash router):
  `#/welcome` onboarding (what it does → region → pick services / detect accounts → done),
  `#/overview`, `#/services` (all registry services, search + category/status filters, track toggle),
  `#/service/<id>` (training facts, data types, region notes, each opt-out with Auto / Guided / Letter /
  Mark done actions, sources, last verified, changelog), `#/letters` (request letter generator),
  `#/creators` (robots.txt / ai.txt / meta / TDMRep generator), `#/alerts`, `#/settings`
  (region, profile for letters, notifications, reminders, passive checks, sync now, export/import/reset,
  permissions granted with revoke buttons), `#/about` (how it works, privacy, limits, open standard).
- Design tokens in `extension/shared/tokens.css`: semantic colours `--nt-primary`, `--nt-good`,
  `--nt-warn`, `--nt-bad`, surfaces and text, radii, spacing, shadows; light and dark themes. The
  in-page overlay lives in a closed shadow root and inlines the same token values.
- Service logos are **not** bundled (trademarks); a monogram tile uses `brandColor`.

## Letters (`lib/letters.js`)

`generateLetter({ service, optOut?, region, kind, profile, date })` → `{ subject, body, to, mailto, legalBasis }`.
Kinds: `objection` (GDPR/UK GDPR Art. 21, FADP), `erasure` (Art. 17 / CCPA deletion), `access` (Art. 15 /
CCPA right to know), `ccpa-opt-out` (CPRA opt-out of sale/sharing + limit use of sensitive PI),
`generic` (any region). Region-appropriate legal citations, response deadlines, placeholders for missing
profile fields, "not legal advice" note in the UI (not in the letter). `mailto` is omitted when there is no
email contact (UI then shows the form URL).

## Creators (`lib/robots.js`)

`generateRobotsTxt({ crawlers, block: 'training'|'all-ai'|'custom', selectedTokens, keepSearch })`,
`generateAiTxt(...)`, `generateMetaTags()` (`noai, noimageai`), `generateTdmRep({ policyUrl })`
(`/.well-known/tdmrep.json` + `tdm-reservation` header). Output is copyable text with comments explaining
what each crawler is and that robots.txt is voluntary.

## Testing

- `npm run test:unit` → `node --test tests/unit/` (pure modules; `tests/unit/helpers/chrome-mock.mjs`
  provides an in-memory `chrome.*` for background modules).
- `npm run test:e2e` → Playwright (`tests/e2e/helpers/extension.mjs` launches Chromium with the unpacked
  extension; headless works). Engine tests load `tests/fixtures/*.html` mock settings pages and inject
  `extension/content/engine.js`. Flow tests can use `context.route('https://chatgpt.com/**', …)` to serve
  fixtures on real hostnames.
- `npm run registry:validate` → schema + invariants. `npm run lint`, `npm run format:check`.

## Proposed standard: `/.well-known/ai-training-opt-out`

Full text in `spec/well-known-ai-training-opt-out.md`, JSON Schema in
`spec/ai-training-opt-out.schema.json`. A service serves `application/json` at
`https://<host>/.well-known/ai-training-opt-out`:

```json
{
  "version": 1,
  "name": "Example Service",
  "trains_on_user_content": "yes",
  "default": "opted_in",
  "opt_out_url": "https://example.com/settings/privacy/ai",
  "policy_url": "https://example.com/privacy#ai-training",
  "data_types": ["posts", "messages"],
  "regions": ["ALL"],
  "last_updated": "2026-09-01",
  "contact": "privacy@example.com"
}
```

Required: `version` (integer, `1`), `trains_on_user_content` (`yes|no|conditional`), `opt_out_url`
(https URL, required unless `trains_on_user_content` is `no`), `last_updated` (`YYYY-MM-DD`). Optional:
`name`, `default` (`opted_in|opted_out|no_choice`), `policy_url`, `data_types` (strings), `regions`
(region codes as in the registry), `contact` (email or https URL). Unknown fields are ignored.
Consumers must ignore documents larger than 64 KB and must only open `opt_out_url` if it is https and on
the same registrable domain as the host (or a documented subdomain).
