---
priority: P2
adopters: BOTH
summary: >-
  RESOLVED (2026-10-09). `branch-metadata-file.ts` checks every `branch.json` read against one zod schema: strict on `status`, `name` and `access`, defaults for the envelope's `version`/`schemaVersion` and for `createdBy`/timestamps, unknown keys passed through. A failure raises `BranchMetadataCorruptError` with a path-free plain cause, `save()` refuses to merge over a corrupt file, and every API guard denies with a plain-language message. On `fix/branch-metadata-robustness`
---
# `branch.json` is never shape-validated

## Status: RESOLVED 2026-10-09

The schema lives in `branch-metadata-file.ts`. Its field map is typed against `BranchMetadata`, so
a field added to the type without a schema entry fails to compile. `BranchMetadataFileManager.load()`
reads through it too, so a save onto a corrupt file throws rather than writing status `'editing'`
with no ACL; repair-metadata still archives first and saves over nothing. `executeGuards` turns a
`BranchMetadataCorruptError` into a 500 with `BRANCH_METADATA_CORRUPT_MESSAGE`
(`branch-metadata-error.ts`, node-free so the client-reachable guards can import it), and the
handler's last-resort catch does the same for handlers that resolve the branch themselves. System
health shows the cause as, for example, "Not branch metadata. Missing: branch.status".

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
  [resolved/submitted-branch-edit-locking.md](submitted-branch-edit-locking.md)).
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
([resolved/schema-store-rmw-protection.md](schema-store-rmw-protection.md)), so the schema
must not assume every on-disk JSON shares one envelope shape.

## Related

- [branch-registry-corrupt-snapshot.md](branch-registry-corrupt-snapshot.md): the same failure class
  for `branches.json`
- `branch-health.ts`: the corrupt-metadata classifier this should feed
