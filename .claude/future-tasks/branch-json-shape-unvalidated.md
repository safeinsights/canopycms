# `branch.json` that parses but has no `branch` key crashes metadata readers

Found 2026-10-04 while testing the base-refresh fix for tracked `.canopy-meta/` state.

## Problem

`BranchMetadataFileManager.loadOnly` checks that `branch.json` is valid JSON, not that it
has the expected shape. A file such as `{"committed":true}` loads "successfully", and
`worker/git-sync.ts`'s base-refresh hygiene step then reads `currentMeta?.branch.conflictStatus`
and throws `TypeError: Cannot read properties of undefined (reading 'conflictStatus')`. The
refresh reports `failed` with that message instead of a corrupt-metadata diagnosis. Measured
with a test fixture; the same `?.branch.` pattern appears in `worker/rebase.ts` and elsewhere.

Reachable when an adopter's repo commits `.canopy-meta/branch.json` (the case the
tracked-state warning now reports), or after a partial or foreign write.

## Fix

Validate the shape in `branch-metadata-file.ts` (schemaVersion, version, `branch` object) and
raise `BranchMetadataCorruptError` for a wrong shape, so every caller gets the existing
corrupt-metadata handling (registry quarantine, branch-health `corrupt-metadata`, repair).

## Files

- `packages/canopycms/src/branch-metadata-file.ts`
- Callers: `worker/git-sync.ts` (base hygiene), `worker/rebase.ts`, `branch-registry.ts`
