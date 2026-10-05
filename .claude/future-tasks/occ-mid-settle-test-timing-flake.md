# `occ-json-write` "lands mid-settle" test is timing-dependent

Seen 2026-10-04: failed once in a full `CI=1 pnpm test` run, passed 3/3 when run alone.

## Problem

`utils/occ-json-write.test.ts` ("throws OccWriteConflictError when another write lands
mid-settle") sleeps 50 ms and then writes an interloper, assuming the writer's rename has
already happened by then. Under full-suite load the interloper can land BEFORE the rename; the
rename then overwrites it, the read-back sees the writer's own `writeId`, and the write resolves
(`{ version: 2, writeId }`) instead of rejecting.

## Fix

Sequence on the event rather than a sleep: inject a hook (or spy on `fs.rename`) that writes the
interloper only after the rename resolves, so the interloper is always inside the settle window.
