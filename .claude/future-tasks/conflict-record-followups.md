---
priority: P3
adopters: BOTH
summary: >-
  The branch conflict record persists until merge, which exposes two edges: an ID recorded for an entry the branch deleted is counted on the Branches badge but shown nowhere else, and an editing branch whose PR merged on GitHub is never archived, so its record never clears
---
# Conflict record: deleted entries and never-archived branches

## Priority: P3 [BOTH]

The worker records ContentIds whose base change a rebase replaced with the branch's version, and
the record persists until `buildMergedBranchUpdate` clears it at archive (`worker/rebase.ts`
`recordConflicts`).

## Edges

- **Deleted entries.** A `UD` conflict (the branch deleted an entry base modified) keeps the delete
  with `git rm` and records the entry's ID; so does deleting an entry that already had a recorded
  conflict. The Branches badge (`BranchManager.tsx`) and System Health count it, but no tree, nav
  or form item carries the notice, since the entry is gone. Either count only IDs that resolve on
  the branch, or record deletions in a shape the editor can show ("deleted here, changed on base").
- **Never archived.** `pollMergeState` runs only for `submitted`/`approved` branches. A branch that
  was withdrawn (PR drafted, status `editing`) whose PR someone then readies and merges on GitHub
  is never archived, so its record stays for good. Polling merge state for `editing` branches that
  still hold a `pullRequestNumber` would archive them however the PR merged.
- **Open question:** whether a reviewer should be able to acknowledge and clear one entry's
  conflict; today only the merge clears the record.

## Trigger

An editor or reviewer reports a conflict count with nothing to find, or a merged branch still
listed as editing.

## Related

- [content-lifecycle-scenarios.md](content-lifecycle-scenarios.md)
