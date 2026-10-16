---
adopters: BOTH
summary: >-
  RESOLVED 2026-10-05, superseded by the context-read fix (load-only reads map `BranchPathError` to NOT_FOUND), by reading. A content read naming the settings branch reads as not found, not a 500
---
# A content read naming the settings branch answers 500, not 404

**Status:** RESOLVED 2026-10-05, superseded by the context-read fix
([context-read-provisions-requested-branch.md](context-read-provisions-requested-branch.md)), by
reading. **Priority: P3 [BOTH].**

Found 2026-10-05 by review round 1 of the settings-branch-not-content fix; by reading, not run.

`createContentReader`'s `resolveBranchContext` (`content-reader.ts`) falls through to
`loadOrCreateBranchContext` when no custom resolver returns a branch. For a settings-branch name,
`resolveBranchPath` (`paths/branch.ts`) now throws `BranchPathError`, which is not a
`ContentStoreError`, so `read`/`readByUrlPath` (`context.ts`) rethrow it to the adopter's error
boundary: a crafted `?branch=canopycms-settings-…` gives a 500 page. The listing paths map the
same error to null through `loadExistingBranch`.

Nothing is provisioned or read, so this is a status-code inconsistency, not a leak.

## Resolution

The context-read fix made `createContentReader` load-only by default and maps any error for which
`namesNoWorkspace` (`paths/branch.ts`) holds, `BranchPathError` included, to NOT_FOUND;
`context.ts`'s read resolver goes through `loadExistingBranch`, which does the same. A settings
name therefore reads as not found on both paths.
