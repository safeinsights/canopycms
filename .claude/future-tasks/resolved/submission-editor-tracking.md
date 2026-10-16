---
priority: P2
adopters: BOTH
summary: >-
  RESOLVED 2026-10-09, branch `feat/submission-editor-attribution`, base `int-202610-b`. branch.json records user ids in `editors` (never reset: each submit rebuilds the whole PR body, which names them all) and `uncommittedEditors` (whom the next submit commit's `Edited-by:` trailers name; that submit removes them). Every successful `writableBranch` endpoint records its user (route-builder.ts), so content saves, renames, deletes and schema changes count, as does the admin duplicate-ID repair, which records its own; asset uploads, which change no branch file, do not. A save that later proves a no-op still counts. Names and emails come from the auth plugin at submit, looked up outside the content-write lock.
---
# Record every editor who touched a branch, not just the submitter

## Priority: P2

Left over from the submit attribution work (2026-10-04). A submit now records the
submitting user in an `Edited-by:` commit trailer and in the canopycms section of
the PR body (`packages/canopycms/src/submission-attribution.ts`). Both already
accept a list of editors: `buildEditorTrailers` takes an array and
`buildPrSection` takes `editors`, rendered as "Also edited by: …".

## What is missing

Nothing records who wrote what on a branch. Content writes carry no user
(`api/content.ts` passes `req.user` for access checks only), and `branch.json`
holds only `createdBy`. The creator is not necessarily an editor, and comment
authors are reviewers as often as editors. So today the trailer and the PR body
name the submitter alone, and edits that other users saved before the submit are
attributed to whoever pressed Submit.

## Shape

- Record the user id (and, at the time of the write, the display name) of each
  content save, per branch. `.canopy-meta/` is the natural home; any
  read-modify-write there needs [docs/concurrency.md](../../../docs/concurrency.md)
  first, because saves from several users on one branch race.
- At submit, pass the editors since the last submit to `buildEditorTrailers`
  (one trailer each) and all editors on the branch to `buildPrSection`.
- Decide whether a write that was later reverted still counts.
