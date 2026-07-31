# E2E remote.git accumulates branch refs and settings commits across runs

**Priority:** P3 — slow leak, not a failure; keeps the two-back-to-back-runs gate honest long-term
**Found:** 2026-07-31, independent review of the e2e coverage sweep (Fable final pass)

## Problem

`apps/test-app/.canopy-dev/remote.git` is deliberately preserved across tests
and runs (recreating it is expensive), and `resetWorkspace()` only
force-resets `refs/heads/main` to the recorded baseline. Two things
accumulate forever:

1. **Branch refs from submit-path tests.** Every test that submits a branch
   pushes a `status-lock-<ts>` / `merge-approved-<ts>` / `sync-badge-<ts>`
   style ref to remote.git (`branch-state-badges.spec.ts` ×3,
   `admin-branch-health.spec.ts` A14, plus the older `branch-workflow`
   specs). Nothing ever prunes them.
2. **Settings commits.** Every permissions/groups PUT rewrites `updatedAt`
   and commits + pushes to the preserved settings branch. The e2e specs'
   save + cleanup steps add a handful of commits per run.
   (`clearPermissionsViaApi` now short-circuits when already empty, which
   removes the guaranteed-no-op commit, but real writes still accumulate.)

Consequences are gradual: remote.git grows without bound on long-lived local
checkouts, `git push` / clone provisioning get marginally slower, and a
future spec that LISTS remote refs would see hundreds of stale ones.

## Fix direction

In `resetWorkspace()` (or a less frequent hook), prune remote refs other than
`main`/the settings branch — `git -C remote.git for-each-ref` + `update-ref
-d`, or `push --prune` from the reset clone. Optionally `git -C remote.git gc
--auto` afterwards. Keep the baseline force-push behavior unchanged.
