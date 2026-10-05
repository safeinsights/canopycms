# `occ-json-write.test.ts` mid-settle conflict test is flaky under load

## Priority: P3 [BOTH]

Seen 2026-10-05 in one full `CI=1 pnpm test` run that overlapped another
vitest process on the same machine. The file passed 3 of 3 runs on its own.
See also [dev-content-watcher-retraction-test-flake.md](dev-content-watcher-retraction-test-flake.md),
which failed in the same run.

## The failure

`occ-json-write > writeOccJsonFile > throws OccWriteConflictError when another
write lands mid-settle` failed.

## Suspected cause

The test lands its competing write inside the settle window by timing, so a
loaded machine can move the write outside the window. Reasoned, not
reproduced.

## Fix sketch

Drive the competing write from a hook inside the settle (or fake timers)
rather than from wall-clock timing.
