# Contributing to NoTrain

Thanks for helping. The registry is only useful if it's accurate and current.

## Correcting or adding a service

1. Edit or create `registry/services/<id>.json`. The schema in
   `registry/schema/service.schema.json` documents every field; `registry/services/chatgpt.json` is a
   good example.
2. Cite first-party sources (help centre, privacy policy, official blog) in `sources`, and set
   `lastVerified` to today's date.
3. If training behaviour or the opt-out options changed in a meaningful way, bump `policyVersion` and
   add a `changelog` entry with the matching `version`. Use `severity: "critical"` when a service
   starts training on user data or turns it on by default. Installed extensions alert users who track
   the service.
4. Run `npm run registry:build`. It validates the entry and regenerates the compiled registry, the
   manifest's optional host permissions and the README table.
5. Open a pull request describing what changed and linking the sources.

Be conservative. If something is unclear, say so in `details` and use `conditional` or `unknown`
rather than guessing.

## Writing an automation recipe

Recipes live in an opt-out's `automation` block and use the small step language described in
[ARCHITECTURE.md](ARCHITECTURE.md#automation-dsl) (`waitFor`, `click`, `setToggle`, `assertToggle`,
`wait`). Match controls by their visible label text, give several `text` candidates, and include
read-only `verify` steps.

Every automated service needs a mock settings page at `tests/fixtures/services/<id>.html` that mirrors
the real page's structure. `npx playwright test tests/e2e/recipes.spec.mjs` runs each recipe against its
mock page. Mark recipes `experimental` unless the label text is documented verbatim by the service.

## Code

- `npm run check` must pass (lint, formatting, registry validation, unit tests), and
  `npm run test:e2e` for anything touching the extension.
- Extension code is plain ES modules with no build step and no runtime dependencies. Never insert
  registry or page data with `innerHTML`.
- Keep permissions minimal. New permissions need a strong reason and an update to `PRIVACY.md`.
