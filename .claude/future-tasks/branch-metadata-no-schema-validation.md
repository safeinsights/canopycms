# `branch.json` is never schema-validated

**Priority:** P2 — no live defect today, but it is the substrate under a whole
class of them
**Found:** 2026-08-12, by the independent review of PR #189
(submitted-branch write locking)

## Problem

`branch-metadata.ts` parses branch metadata with a bare cast and no runtime
validation:

```ts
return JSON.parse(raw) as BranchMetadataFile   // branch-metadata.ts:112
const parsed = JSON.parse(raw) as BranchMetadataFile   // and again ~:139
```

There is **zero Zod in the file**. Every field on `BranchMetadata` — `status`,
`name`, `access`, the OCC envelope's `version`/`writeId` — is typed as required
but can be absent, misspelled, or the wrong type at runtime, and nothing notices.

The file is an OCC envelope (`{schemaVersion, version, writeId, branch: {...}}`),
so a fixture or repair script that patches the top level writes fields nothing
reads — a failure mode the e2e sweep already hit once and recorded.

## Why it matters

This is what made PR #189's guard bug *reachable*, and it is worth understanding
as a pattern rather than a one-off. The fix there computed:

```ts
writeBlocked: readOnly || (status !== undefined && status !== 'editing')
```

which reads as defensive, and is — but it fails **open**: an `undefined` status
allows the write, where the pre-existing guard (`status !== 'editing'`) blocked
it. The type system said `status` was always present, so the `undefined` branch
looked unreachable. It is only unreachable if the data is validated, and it is
not.

`getBranchWriteProtection()` now takes a **required** status typed to admit
`undefined` precisely so that "the caller did not ask about status" and "the file
had no status" cannot be confused — see the reasoning recorded inline in
[resolved/submitted-branch-edit-locking.md](resolved/submitted-branch-edit-locking.md).
That is a local fix for one call path. The underlying gap is repo-wide.

The realistic sources of a malformed `branch.json` are not hypothetical:

- a partially-written file on EFS with a concurrent Lambda writer
- an operator hand-repairing metadata during recovery (the runbook in
  `docs/deploying-to-aws.md` contemplates exactly this)
- a directory that `branch-health.ts` classifies as corrupt-metadata — the fact
  that a whole admin subsystem exists to detect and quarantine corrupt branch
  metadata is itself the argument that it happens

## Fix direction

Validate at the read boundary with a Zod schema, consistent with how the settings
workspace already treats `permissions.json` and `groups.json`. Decide explicitly
what a parse failure means — most likely: surface it as corrupt-metadata so the
existing quarantine/branch-health path handles it, rather than throwing into
whatever called `load()`.

Note the constraint that shaped the current design: the git-committed
`.collection.json` deliberately carries no OCC fields (an approved deviation
recorded in [resolved/schema-store-rmw-protection.md](resolved/schema-store-rmw-protection.md)),
so whatever validation lands must not assume every on-disk JSON shares one
envelope shape.

## Related

- [resolved/submitted-branch-edit-locking.md](resolved/submitted-branch-edit-locking.md)
  — carries the fail-closed rationale inline
- [program-b-final-review-followups.md](program-b-final-review-followups.md)
- `branch-health.ts` — the corrupt-metadata classifier this should feed
