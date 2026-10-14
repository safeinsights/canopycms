---
priority: P3
adopters: BOTH
summary: >-
  A submit that stamps a new entry's `stampOnPublish` field and then fails (push rejected, lock lost, metadata save throws, response never arrives), or whose stamping throws part-way, reports no `stamped`, so an unsaved draft on that entry still gets a version-conflict 409 on its next save. Proposed: when a save 409s, re-read the entry and adopt the server's version if the only difference is stamp fields the draft left empty
---
# A failed submit's stamps still 409 an open draft

## Priority: P3 [BOTH]

## Problem

Stamping writes the entry file inside `submitBranch`'s content-write lock, before the commit and
push (`services.ts:466`, `stamp-on-publish.ts`), which gives the file a new mtime version token.
On a 200 the submit response lists each stamped entry with its previous and new version
(`api/branch-status.ts:213`), and the editor moves the token and any pending draft onto the new
version (`useDraftManager.applySubmitStamps`, `useDraftManager.ts:1274`), keeping the submit
dialog's promise that unsaved changes stay unsaved through review (`useBranchManager.tsx:97`).

Every other outcome drops that list: a push failure (500, or the non-fast-forward 409), a
`ContentWriteLockBusyError` with outcome `unknown`, a throwing metadata save, or a response that
never arrives. The stamp stays on disk, a retry finds the field filled and stamps nothing, and the
editor's next save of that entry sends the old token and gets "This entry changed since you opened
it", whose only remedy today discards the draft (`api/entries-constants.ts:21`). The branch is
still `editing` after a failed push, so the editor can hit this immediately.

A 200 can drop it too: when `stampNewEntries` throws after writing some stamps (listing a later
collection fails), `stampNewEntriesOrWarn` (`services.ts:391`) warns and returns `[]`, so the
written stamps are committed but never reported.

`services.submit-branch.test.ts` pins the failed-push case ("a failed push after stamping reports
no stamps (drafts re-sync via the 409 path)").

## Proposed fix

Client-side, which covers every path including other tabs: on a version-mismatch 409, re-read the
entry; if the server value differs from the loaded value only in `stampOnPublish` fields that are
empty in both the loaded value and the draft, adopt the read's version, fill those fields (the
`applySubmitStamps` rule) and retry the save. A server-side alternative (carry `stamped` on error
responses and keep it in branch metadata until a submit answers 200) still misses unanswered
responses. The general recovery in [reload-keeps-draft.md](reload-keeps-draft.md) also covers it,
at the cost of the editor clicking "Reload and keep my edits".

## Trigger

An editor reports losing a draft after a failed or timed-out submit, or reload-keeps-draft is
scheduled (fold this in).
