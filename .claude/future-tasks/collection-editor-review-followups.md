---
priority: P3
adopters: BOTH
summary: >-
  Six code follow-ups from reviewing the collection dialog: Title Case placeholders and a lint:ux-copy check for them, create-mode Undo, ConfirmDeleteModal's close button while loading, a VoiceOver check of the status line, a hung request locking the dialog, and Editor.tsx's unguarded getCollection response
---
# Collection dialog: review follow-ups

## Code follow-ups

- **Placeholders in sentence case.** docs/ux-guidelines.md's sentence-case rule covers
  placeholders, but "Blog Posts" (`schema-editor/CollectionEditor.tsx`) and "Blog Post"
  (`schema-editor/EntryTypeEditor.tsx`) are Title Case. Fix them and extend `lint:ux-copy`
  (`scripts/check-ux-copy.mjs`) to check `placeholder` props.
- **Create-mode Undo.** Removing a staged entry type in create mode still confirms in a modal. The
  guideline asks for Undo instead of a confirm for removals inside a form. Remove at once and offer
  Undo (`UndoToastMessage`), keeping the confirm in edit mode, where the removal saves immediately.
- **`ConfirmDeleteModal` while loading.** Its close button looks active while `loading`, though the
  caller's `onClose` ignores it. Pass `closeButtonProps={{ disabled: loading }}`
  (`editor/components/ConfirmDeleteModal.tsx`, shared by several dialogs).
- **Screen-reader check.** After an entry-type add or update, the status line updates while the
  closing sub-dialog is still in the DOM with `aria-modal`. Some screen readers suppress live-region
  updates outside the active modal. Check with VoiceOver; if it is swallowed, announce after the
  sub-dialog's exit transition.
- **A hung request locks the dialog.** The collection dialog and its entry-type dialog can't be
  dismissed while a request is in flight, so a request that never settles leaves both open until a
  reload, which loses staged details. [api-client-no-request-timeout.md](resolved/api-client-no-request-timeout.md)
  bounds every request; check the dialog releases once it lands.
- **Stale collection fetch.** `Editor.tsx`'s `handleOpenCollectionEditor` awaits `getCollection`
  without dropping a stale response. Two quick opens could let a late response replace
  `editingCollection` mid-session, which resets the dialog's local entry-type list and its
  Close/Discard state. Ignore responses for an opening that is no longer current.
