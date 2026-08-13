# Lint guard: keep node-importing modules out of the client-bundle graph

**Priority:** P2 — **RESOLVED 2026-07-25**

## Resolution

Implemented as a `dependency-cruiser` reachability rule rather than the ESLint
zones proposed below:

- `.dependency-cruiser.mjs` (repo root) — rule
  `client-bundle-no-node-builtins`: nothing reachable from
  `packages/canopycms/src/client.ts` or `packages/canopycms-next/src/client.tsx`
  may reach a node built-in. `tsPreCompilationDeps` off, so `import type` edges
  are not followed (matching what the bundler sees). Second rule,
  `no-unresolvable-local-imports`: a relative import the resolver can't follow
  is a subtree the reachability rule can't see, so it fails rather than
  silently blinding the guard.
- `pnpm lint:bundle` (root) — CI step right after ESLint (~1.4s), and a
  lint-staged entry that fires once per commit touching either package's `src/`.
- Documented in DEVELOPING.md → "Client-Bundle Boundary Check"; the stale "this
  boundary is enforced by convention, not a lint rule" line in the asset
  client-safety section now points at the check.

Why reachability instead of ESLint zones: the client graph is not a directory.
`src/api/guards.ts`, `src/authorization/protected-branch.ts`,
`src/operating-mode/client-safe-strategy.ts` and 150-odd other modules are all
reachable from `client.ts`, so zones scoped to `src/editor/**` + `src/client.ts`
would have caught regression 2 but not regression 1 — and hand-maintaining the
file list is exactly the drift that let regression 1 through. The graph rule
needs no list, and its error output prints the full offending chain.

Verified by reintroducing both historical imports and confirming the rule fires.

Known gap (e2e production `next build` remains the backstop): `node_modules` is
resolved but not followed, so a server-only npm package (`sharp`, `simple-git`,
the S3 SDK) imported from client code is not detected.

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
