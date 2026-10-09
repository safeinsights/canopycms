---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-04. `vitest.config.ts` raises `testTimeout` to 30000 for git-heavy suites but leaves `hookTimeout` at 10000, and the `src/__integration__/` suites do their `createTestWorkspace` git setup in `beforeEach`. One loaded local run timed out `occ-version-less-write.test.ts`'s setup (3 failures, 2 unhandled errors); the file alone and the next full run passed. Fix: set `hookTimeout` too
---
# [P3] Integration-suite setup hooks run under vitest's 10s default

New 2026-10-04, seen while re-running gates for the workflow-push fix.

## What happens

`packages/canopycms/vitest.config.ts` raises `testTimeout` to 30000 for the node project
because git-heavy suites spawn real git per test, but leaves `hookTimeout` at vitest's default
10000. The `src/__integration__/` suites that use `createTestWorkspace` each have a `beforeEach`
(17 test files), which is where that git setup runs, with a third of a test's headroom.

Measured on one local `CI=1 pnpm test` run, straight after `pnpm build`:
`src/__integration__/workflows/occ-version-less-write.test.ts` failed 3 tests with
"Hook timed out in 10000ms" at its `beforeEach`, and the half-built workspace then produced
ENOTEMPTY cleanup failures and two unhandled rejections ("Errors 2 errors"). The same file run
alone passed 5/5 three times, taking 32-47s for 5 tests, and the full suite passed on the next
run with no change. A setup that takes several seconds unloaded is a timeout under load.

## Fix

Set `hookTimeout` alongside `testTimeout` in the node project, and extend the comment above
them to cover both.
