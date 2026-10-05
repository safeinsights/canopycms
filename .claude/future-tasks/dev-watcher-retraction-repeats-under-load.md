# [P3] Dev content watcher: the "synced" retraction can repeat under load

`packages/canopycms/src/dev-content-watcher.test.ts:205`, in "announces the retraction when
the divergence is resolved", failed once in a full `CI=1 pnpm test` run (2026-10-05, on
`fix/content-write-lock-coverage` merged with `int-202610-a` at `1990511c`) with
`expected [ …(2) ] to have a length of 1 but got 2`. The test asserts that rewriting an
already-agreeing file twice does not announce the retraction again, so the retraction was
announced twice. It passed 5 of 5 runs in isolation; no change on that branch touches the
watcher. The failing run was **unsandboxed**, so this is not the known sandbox-only failure
of the repeat-suppression tests on the dev machine.

Find out whether this is the test or the product. A slow host can deliver the earlier
branch-side write's file event late, but suppression is meant to hold whatever order checks
run in. If two overlapping checks can each see "was divergent, now agrees" and both announce,
the watcher has a real repeat bug that only load exposes. If not, make the test deterministic:
wait for the watcher to go idle rather than sleeping a fixed `CHECK_SETTLE_MS`.
