# Schema-store "branch directory disappears mid-contention" test flakes under load

## Priority: P3 [NEITHER]

Seen 2026-10-06 in one full `CI=1 pnpm test` run; passed in three isolated runs and the next
full run.

## The flake

`src/schema/schema-store.test.ts`, "maps a lock-acquisition failure into SchemaStoreBusyError
once the branch directory disappears mid-contention", expected `SchemaStoreBusyError` and got
`Error: Collection meta not found: posts`.

The test assumes the queued `addEntryType` is still retrying the schema lock when the holder
removes the branch root, so its next attempt hits ENOENT. The error suggests that under
full-suite load the attempt instead got past the lock after the removal and then failed reading
the collection meta that went with the branch root. That ordering is unconfirmed.

## Proposed solution

Confirm that ordering first, then make the test deterministic: hold the queued attempt inside its
retry until the removal completes, or accept either error if both are correct outcomes of a
deleted branch.
