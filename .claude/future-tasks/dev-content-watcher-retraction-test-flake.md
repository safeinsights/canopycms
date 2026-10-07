# `dev-content-watcher.test.ts` retraction test is flaky under load

## Priority: P3 [BOTH]

Seen 2026-10-05 in one full `CI=1 pnpm test` run on an unrelated change; the
file passed 3 of 3 runs on its own, and two other full runs that day passed.

## The failure

`startDevContentWatcher > repeat suppression > announces the retraction when
the divergence is resolved` failed at its last assertion:
`expected [ …(2) ] to have a length of 1 but got 2`, so the "synced" retraction
was announced twice.

## Suspected cause

The test resolves the divergence with two separate writes (branch file, then
working-tree file) and then rewrites the working-tree file twice with
`settle()` between. Under load the watcher can observe a state between writes
and report a divergence and its retraction again. Reasoned, not reproduced.

A second sighting, the same day, was in an **unsandboxed** full run of
`fix/content-write-lock-coverage` merged with int, so it is not the known
sandbox-only failure of the repeat-suppression tests. Rule out the product before
fixing the test: if two overlapping checks can each see "was divergent, now
agrees" and both announce, the watcher has a real repeat bug that load exposes.

## Fix sketch

Make the resolving writes atomic from the watcher's view, or assert on the
transition count after the watcher is quiescent rather than after a fixed
settle.
