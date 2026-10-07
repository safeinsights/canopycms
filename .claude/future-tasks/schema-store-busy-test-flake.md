# Flaky test: SchemaStoreBusyError when the branch directory disappears

## Priority: P3 [BOTH]

`src/schema/schema-store.test.ts`, the test "SchemaOps > concurrency > maps a lock-acquisition
failure into SchemaStoreBusyError once the branch directory disappears mid-contention", fails
intermittently. It rejects with `Collection meta not found: posts` instead of
`SchemaStoreBusyError`.

Measured locally on 2026-10-06: it failed in 1 of 3 isolated runs of the file, and once in a full
`CI=1 pnpm test` run. No file it exercises changed on the branch where this was seen, and it uses
no git.

The test races the branch directory's removal against lock acquisition, so whichever of
"meta read" and "lock attempt" loses decides the error. Either make the test deterministic, by
holding the lock until the directory is gone, or make the store map both outcomes to
`SchemaStoreBusyError`.
