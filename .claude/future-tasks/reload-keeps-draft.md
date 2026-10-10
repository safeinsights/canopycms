---
priority: P2
adopters: BOTH
summary: >-
  Every save-conflict message tells the editor to Reload, and Reload always discards the entry's
  unsaved draft, so after a 409 the only way forward loses the work the editor just tried to save.
  The worst case is `WRITE_OUTCOME_UNKNOWN` when the write did not land. Add a Reload that keeps the
  draft and re-stamps it onto the freshly loaded version, so the editor can review and save again
---

# [P2] Reload after a save conflict throws away the editor's draft

**Priority:** P2 [BOTH].

## What happens

`useDraftManager`'s `performReload` (`packages/canopycms/src/editor/hooks/useDraftManager.ts`)
loads the server copy and deletes the entry's draft. `handleReload` guards it with a confirm modal
when the entry is dirty ("Unsaved changes for this file will be lost"). No reload path keeps the
draft.

Each save 409 tells the editor to Reload, and the messages say "(your unsaved edits will be
lost)":

- version mismatch, including the client's stale-draft check;
- `WRITE_OUTCOME_UNKNOWN`, where the content-write lock was lost mid-write and the write may or may
  not have landed;
- the hold that follows `WRITE_OUTCOME_UNKNOWN`, which blocks further saves of the entry until it
  is re-read or reloaded;
- the no-version-token refusal.

When an outcome-unknown write did land, the reloaded copy equals the draft and nothing is lost.
When it did not land, the editor's only way out discards exactly the edit they were trying to save.
On a version mismatch, the editor loses their work to see someone else's.

## Shape of the fix

A second reload action, "Reload and keep my edits":

- Load the server copy and record its version token as the draft's base, so the next save sends a
  current `expectedVersion`.
- Keep the draft as the working value. Show a field-level or entry-level diff against the reloaded
  copy if one is cheap, or at least a notice that the entry changed underneath.
- Release the `WRITE_OUTCOME_UNKNOWN` hold, as a plain reload does.

**Decided (JP, 2026-10-10):** keep-my-edits sits next to the existing discarding Reload; it does
not replace it as the default. The conflict notifications and the confirm modal offer both, and
the "(your unsaved edits will be lost)" copy then applies only to the discarding action. The draft-retention rules in
[draft-publish-lifecycle.md](draft-publish-lifecycle.md) apply.

[BOTH]
