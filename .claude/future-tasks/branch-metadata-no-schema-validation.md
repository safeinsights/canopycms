# `branch.json` is never shape-validated

**Priority:** P2 [BOTH]. A partially written or hand-repaired `branch.json` on EFS reaches guards that
treat an undefined field as open, and readers that crash on a missing `branch` object.

## Problem

`branch-metadata.ts` (line 88) and `branch-metadata-file.ts` (line 67) parse branch metadata with a
bare `JSON.parse(raw) as BranchMetadataFile` and no runtime validation. Every field on
`BranchMetadata` (`status`, `name`, `access`, the OCC envelope's `version` / `writeId`) is typed as
required but can be absent, misspelled or the wrong type at runtime.

- **Fails open.** A guard written as `writeBlocked: readOnly || (status !== undefined && status !==
  'editing')` reads as defensive but allows the write when `status` is `undefined`. The type system
  says `status` is always present, so that branch looks unreachable; it is only unreachable if the data
  is validated. `getBranchWriteProtection()` takes a required status typed to admit `undefined` so
  "caller did not ask" and "file had no status" cannot be confused: a local fix for one call path (see
  [resolved/submitted-branch-edit-locking.md](resolved/submitted-branch-edit-locking.md)).
- **Crashes readers.** `BranchMetadataFileManager.loadOnly` checks valid JSON, not shape. A file such
  as `{"committed":true}` loads "successfully", and `worker/git-sync.ts` (base-refresh hygiene step,
  line 719) then reads `currentMeta?.branch.conflictStatus` and throws `TypeError: Cannot read
  properties of undefined (reading 'conflictStatus')`, so the refresh reports `failed` with that message
  instead of a corrupt-metadata diagnosis. The same `?.branch.` pattern appears in `worker/rebase.ts`
  and elsewhere.

The file is an OCC envelope (`{schemaVersion, version, writeId, branch: {...}}`), so a fixture or repair
script that patches the top level writes fields nothing reads.

Realistic sources of a malformed file: a partial write on EFS with a concurrent Lambda writer, an
operator hand-repairing metadata (the runbook in `docs/deploying-to-aws.md` contemplates it), an adopter
repo that commits `.canopy-meta/branch.json`, and any directory `branch-health.ts` classifies as
corrupt-metadata, a subsystem whose existence is itself the argument.

## Fix

One zod schema at the read boundary (schemaVersion, version, `branch` object, `status` among the known
values), consistent with how the settings workspace treats `permissions.json` and `groups.json`. A
parse or shape failure raises `BranchMetadataCorruptError`, so every caller gets the existing
corrupt-metadata handling (registry quarantine, branch-health `corrupt-metadata`, repair) instead of
throwing into whatever called `load()`.

Constraint: the git-committed `.collection.json` deliberately carries no OCC fields
([resolved/schema-store-rmw-protection.md](resolved/schema-store-rmw-protection.md)), so the schema
must not assume every on-disk JSON shares one envelope shape.

## Related

- [branch-registry-corrupt-snapshot.md](branch-registry-corrupt-snapshot.md): the same failure class
  for `branches.json`
- `branch-health.ts`: the corrupt-metadata classifier this should feed
