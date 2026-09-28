## What this changes

<!-- One or two sentences. Link the issue it fixes, e.g. "Fixes #123". -->

## Type of change

- [ ] Registry: new service or correction (`registry/services/*.json`, `registry/crawlers.json`)
- [ ] Extension code
- [ ] Tooling, CI or docs
- [ ] The `/.well-known/ai-training-opt-out` spec

## Checklist

- [ ] `npm run check` passes (lint, formatting, registry validation, unit tests)
- [ ] `npx playwright test` passes, if extension code or automation recipes changed
- [ ] `npm run registry:build` was run and its output committed, if the registry changed

### Registry changes

- [ ] Every claim is backed by a first-party source in `sources[]`, and `lastVerified` is today's date
- [ ] `policyVersion` was bumped and a `changelog` entry added if training behaviour or opt-out options changed (with the right `severity`)
- [ ] Automation recipes were tested against a fixture in `tests/fixtures/` (see CONTRIBUTING.md) and use the lowest honest `confidence`

### Extension changes

- [ ] No new permissions, or the new permission is justified in `store/listing.md` and `PRIVACY.md`
- [ ] No data leaves the device; no remote code
- [ ] Keyboard and screen-reader accessible; works in light and dark mode
