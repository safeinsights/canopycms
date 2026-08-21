# `canopycms/test-utils` is a published export that is never built

Found 2026-08-20 while writing `scripts/check-esm-imports.mjs` (the ESM-import regression
guard added alongside the fix for adopter-request-log item #19). Not one of the two
defects that session fixed — a separate, pre-existing issue surfaced by the same
verification work.

## What's broken

`packages/canopycms/package.json` declares:

```json
"exports": { "./test-utils": "./src/test-utils/index.ts", ... },
"publishConfig": { "exports": { "./test-utils": { "import": "./dist/test-utils/index.js", ... } } }
```

But `packages/canopycms/tsconfig.build.json` excludes `src/test-utils/**` from compilation
(added in commit `461ef995`, "Fix publish: exclude test files from tarball"). The two were
never reconciled: `dist/test-utils/` is never produced, so `publishConfig.exports` advertises
an entry point that does not exist in the published tarball. Any external consumer running
`import { mockConsole } from 'canopycms/test-utils'` gets `ERR_MODULE_NOT_FOUND`.

Verified directly: `pnpm pack` for `canopycms` produces a tarball whose `package.json` lists
`"./test-utils"` in `exports`, but the tarball itself has no `dist/test-utils/` at all.

## Why nobody noticed

Within the monorepo, everything imports `canopycms/test-utils` from a `.test.ts` file
(`packages/canopycms-auth-clerk/src/clerk-plugin.test.ts` is the only current use), which
resolves through the workspace's DEV `exports` field (`./src/test-utils/index.ts` directly,
via the TS source) — not through `publishConfig`. The break only shows up for a real npm/pnpm
install of the published package, which is presumably why the adopter site's own request log
(`.claude/future-tasks/adopter-request-log-intake.md`) doesn't mention it either — nobody has
tried to import it externally yet.

## Fix direction (not attempted here — needs a decision, not just a patch)

Two legitimate directions, and the choice affects tarball size:

1. **Stop excluding `test-utils` from the build** (drop it from `tsconfig.build.json`'s
   `exclude`) so `dist/test-utils/` actually gets produced. Check first whether anything in
   `src/test-utils/` imports `vitest` or `@testing-library/*` at module scope — those are
   devDependencies, and shipping a runtime import of a devDependency in the published `dist`
   would be its own bug even after this fix.
2. **Remove `"./test-utils"` from both `exports` and `publishConfig.exports`** if it was never
   meant for external consumers — it would still work for the one in-repo `.test.ts` consumer
   above, since that resolves via workspace linking, not the published exports map.

Whichever direction is chosen, add `canopycms/test-utils` to
`scripts/check-esm-imports.mjs`'s `PACKAGES` list (currently explicitly skipped there with a
comment pointing at this file) so a regression can't ship silently again.
