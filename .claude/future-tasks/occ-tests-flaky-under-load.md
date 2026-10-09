---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-04. Under a full local `CI=1 pnpm test`, three OCC tests failed with timing signatures: `occ-json-write`'s mid-settle conflict resolved instead of rejecting, and `occ-version-less-write`'s setup hook timed out at 10s. Both files pass alone. Make the interleaving deterministic instead of wall-clock dependent
---
# OCC tests fail under full-suite load and pass alone

## Priority: P3

Observed 2026-10-04 on a local `CI=1 pnpm test` run of the whole monorepo, at int-202610-a
4b027e8a plus an unrelated branch. Three tests failed with timing signatures. Both files then
passed twice, run on their own (23/23).

- `packages/canopycms/src/utils/occ-json-write.test.ts`: "writeOccJsonFile › throws
  OccWriteConflictError when another write lands mid-settle". The promise resolved
  (`{ version: 2, … }`) instead of rejecting, so the "concurrent" write did not land inside
  the settle window.
- `packages/canopycms/src/__integration__/workflows/occ-version-less-write.test.ts`: "accepts
  an update carrying the version it read" and "refuses a version-less write after the entry was
  deleted and recreated…". A hook timed out at 10000ms, and the run reported stderr output
  under CI.

Seen once locally, not yet in CI. A test whose race depends on wall-clock interleaving will fail
on a slow or loaded CI runner too.

## Fix shape

Make the mid-settle interleaving deterministic (inject the settle delay or a hook that runs the
competing write at a fixed point) rather than relying on timing, and give the integration file's
setup hook a budget that matches what it does, or shrink the setup.
