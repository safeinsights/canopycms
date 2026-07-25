# Lint guard: keep node-importing modules out of the client-bundle graph

**Priority:** P2

## Problem

Twice in two days a branch dragged `node:fs`/`node:path` into the editor's
browser bundle by importing `sanitizeBranchName` from `paths/branch.ts`
(which pulls node built-ins top-level) instead of the dependency-free
`paths/branch-name.ts`:

1. Branch-protections epic: `api/guards.ts → authorization/protected-branch.ts
   → paths/branch.ts` (fixed by extracting `paths/branch-name.ts`).
2. UX-review epic: `editor/hooks/useBranchManager.tsx → paths/branch.ts`
   (imported the "right" symbol from the wrong module in a parallel branch —
   its comment even showed bundle awareness).

Both were caught only by the e2e production `next build` (webServer CI path),
which is a late, ~3-minute signal. `next dev` tolerates the violation, so
nothing flags it at authoring time.

## Proposed fix

ESLint `no-restricted-imports` (or `import/no-restricted-paths` zones) in the
package config: forbid `**/paths/branch`, `**/paths` (barrel), and other
known node-heavy modules from being imported anywhere under `src/editor/**`,
`src/client.ts`, and other client-entry-reachable trees, with a message
pointing at the dependency-free alternatives (`paths/branch-name`,
`assets/asset-prefixes`, `assets/transform-directives`). Zones config scales
better than per-module lists if the client tree grows.

Cheap, fires in-editor and in the pre-commit hook — days earlier than the e2e
build. Keep the e2e prod build as the backstop (it catches transitive chains
lint zones can miss).
