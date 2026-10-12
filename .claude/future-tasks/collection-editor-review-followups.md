---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-12, from reviewing the collection dialog's honest-Cancel fix. Four guideline gaps that need a ruling (dismiss wording in mixed staged/immediate dialogs, Remove vs Delete for schema objects, a safe success-text colour, sentence case in placeholders) and five small code follow-ups (create-mode Undo, ConfirmDeleteModal's close button while loading, a VoiceOver check of the status line, a hung request locking the dialog, Editor.tsx's unguarded getCollection response)
---
# Collection dialog: review follow-ups

## Guideline gaps (need a ruling in docs/ux-guidelines.md)

- **Dismiss wording in a dialog that mixes staged and immediate changes.** `schema-editor/CollectionEditor.tsx`
  says "Discard changes" while staged edits exist, "Close" once an immediate change has saved, and
  "Cancel" otherwise. Decide whether that is the general rule, and record it under Copy or
  Destructive actions.
- **Remove or Delete for schema objects.** The Vocabulary table lists Delete for entries, collections,
  branches and groups only. An entry type is stored state, but the dialog says "Remove" (taking it out
  of the collection's list). Name the rule for entry types and similar schema objects.
- **Success text colour.** Mantine's `green.8` and `green.9` both miss 4.5:1 on white. The collection
  dialog keeps success text in the default colour with a green icon; say so under Colour and contrast.
- **Placeholders.** `lint:ux-copy` doesn't check placeholders, so example text such as "Blog Posts"
  (`CollectionEditor.tsx`) and "Blog Post" (`EntryTypeEditor.tsx`) is Title Case. Decide whether
  placeholders follow sentence case, and extend the lint if so.

## Code follow-ups

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
  reload, which loses staged details. [api-client-no-request-timeout.md](api-client-no-request-timeout.md)
  bounds every request; check the dialog releases once it lands.
- **Stale collection fetch.** `Editor.tsx`'s `handleOpenCollectionEditor` awaits `getCollection`
  without dropping a stale response. Two quick opens could let a late response replace
  `editingCollection` mid-session, which resets the dialog's local entry-type list and its
  Close/Discard state. Ignore responses for an opening that is no longer current.
