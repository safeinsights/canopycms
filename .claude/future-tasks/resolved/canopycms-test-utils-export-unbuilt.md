# `canopycms/test-utils` is a published export that is never built

**RESOLVED 2026-08-20** (branch `fix/canopycms-test-utils-export`, off
`epic/adopter-request-intake`). Resolution: the subpath is now **workspace-internal by
design** — removed from `publishConfig.exports`, kept in the dev `exports` map. See
[Resolution](#resolution) below.

Found 2026-08-20 while writing `scripts/check-esm-imports.mjs` (the ESM-import regression
guard added alongside the fix for adopter-request-log item #19). Not one of the two
defects that session fixed — a separate, pre-existing issue surfaced by the same
verification work.

## What was broken

`packages/canopycms/package.json` declared:

```json
"exports": { "./test-utils": "./src/test-utils/index.ts", ... },
"publishConfig": { "exports": { "./test-utils": { "import": "./dist/test-utils/index.js", ... } } }
```

But `packages/canopycms/tsconfig.build.json` excludes `src/test-utils/**` from compilation
(added in commit `461ef995`, "Fix publish: exclude test files from tarball"). The two were
never reconciled: `dist/test-utils/` is never produced, so `publishConfig.exports` advertised
an entry point that does not exist in the published tarball. Any external consumer running
`import { mockConsole } from 'canopycms/test-utils'` got `ERR_MODULE_NOT_FOUND`.

Verified directly: `pnpm pack` for `canopycms` produced a tarball whose `package.json` listed
`"./test-utils"` in `exports`, but the tarball itself had no `dist/test-utils/` at all.

## Why nobody noticed

Within the monorepo, everything imports `canopycms/test-utils` from a `.test.ts` file
(`packages/canopycms-auth-clerk/src/clerk-plugin.test.ts` is the only current use), which
resolves through the workspace's DEV `exports` field (`./src/test-utils/index.ts` directly,
via the TS source) — not through `publishConfig`. The break only shows up for a real npm/pnpm
install of the published package, which is presumably why the adopter site's own request log
([adopter-request-log-intake.md](../adopter-request-log-intake.md)) doesn't mention it either —
nobody had tried to import it externally.

## Resolution

The git history settled the question. `461ef995` (2026-03-24) added the build exclusion at a
time when `"./test-utils"` was **not** an export — the exports map ended at `"./build"`, so
the exclusion was correct as written. Two days later `eaa09e42` (2026-03-26) added the
subpath for an explicitly workspace-internal reason: *"Add canopycms/test-utils subpath
export replacing fragile cross-package relative imports."* The `publishConfig.exports` half
came along by rote symmetry with every other entry. Publishing this was never a decision
anyone made.

Building and shipping it was evaluated empirically (exclusion dropped, package rebuilt) and
rejected. It compiles cleanly, but the emitted output disqualifies itself three ways:

- `dist/test-utils/console-spy.js` and `dist/test-utils/api-test-helpers.js` both emit
  `import { vi, expect } from 'vitest'` — putting a devDependency in the published runtime
  graph.
- `console-spy.js` ends in a top-level `expect.extend(consoleMatchers)`, so merely importing
  the module requires a live vitest context, not just vitest installed.
- `console-spy.d.ts` ships `declare module 'vitest'`, which would attach CanopyCMS's custom
  matchers to **every** consumer's `Assertion` interface, and `api-test-helpers.d.ts` would
  freeze internal types (`ApiContext`, `CanopyServices`, `BranchContext`) into the public API.

Against that, demand was one line: `mockConsole` in `clerk-plugin.test.ts`. The 16 exported
helpers are mocks of CanopyCMS's own internals — nothing an adopter (config + Editor + one
catch-all route) would call.

Decision (JP, 2026-08-20): **stop publishing it, keep it workspace-internal.** `"./test-utils"`
was removed from `publishConfig.exports` only. It remains in the dev `exports` map, so the
cross-package import keeps working unchanged and no fragile relative import comes back.

The invariant is now enforced rather than documented. `scripts/check-esm-imports.mjs` gained a
third subpath mode alongside `test` and `skip`: `devOnly`. Its `checkCoverage()` cross-checks
the dev `exports` map against `publishConfig.exports` and fails if a `devOnly` subpath
reappears in `publishConfig`, if a published subpath goes missing from it, or if the two maps
disagree in either direction. All three directions were verified to fail as intended before
landing. The old `skip:` entry pointing at this file is gone.

ARCHITECTURE.md's "Package Architecture" section and CODEBASE_GUIDE.md's "Test Utilities"
section were corrected — both previously described the subpath as available to adopters.
