---
priority: P2
adopters: BOTH
summary: >-
  RESOLVED (2026-10-13). Submitting the open branch asks `resolveUnsaved` first; with unsaved edits the submit confirm warns in yellow that the named entries won't be submitted, and its confirm reads "Submit anyway". One dialog, so no modal opens from a modal
---
# Warn when submitting with unsaved changes

## Status: RESOLVED 2026-10-13

`useBranchManager`'s `getUnsaved` option, wired from `Editor.tsx`; tested in `useBranchManager.test.tsx`. A "Save first" button that saved every entry was not added: there is no save-all, so the dialog says to cancel and save instead.

In example1, typing into an entry and then submitting the branch submitted only the saved
content, with no prompt. The unsaved edit survives as a kept draft behind
`ReadOnlyDraftNotice`, so nothing is lost, but the editor believed it had submitted it.

## Fix

Before submit, call `resolveUnsaved` (`hooks/useDraftManager.ts`, already used by branch switch
and create) and confirm: "N entries have unsaved changes that won't be submitted." with Save
first and Submit anyway.
