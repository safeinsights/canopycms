---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-12. An unanswered collection create or details save closes the collection dialog, so if the write did not land the user re-enters the name, label and every staged entry type. Keep the staged input and offer it on the next open, or put a restore action on the toast
---

# An unanswered collection create or details save loses what was entered

**Status:** Open. **Priority: P3.** Filed 2026-10-12 from the UX review of the phase 3
final-review fixes.

## State

When a collection create or a details save gets no answer (a timeout, or a gateway's 5xx
page), `handleCollectionSave` in `packages/canopycms/src/editor/Editor.tsx` closes the
collection dialog, and `useSchemaManager`'s sticky toast says where to check. Closing is
deliberate:

- **Create:** each create gets a new content id, so retrying one that had landed makes a second
  collection. Leaving the dialog open invites exactly that retry.
- **Details save:** a slug rename that landed leaves `editingCollection.logicalPath` stale, so
  every later action from the open dialog would 404.

The cost is the input. A create that did not land loses the name, the label and every staged
entry type (about six fields each); a details save loses up to three fields. That breaks the
guideline that errors keep the user's input (`docs/ux-guidelines.md`), which allows closing
only because a retry could duplicate the write.

## Fix direction

- Keep the staged `CreateCollectionInput` (or the details update) in `Editor.tsx` and prefill
  the dialog the next time "New collection" (or that collection's Edit) opens for the same
  parent, with a way to discard it.
- Or put a "Restore what you entered" action on the toast, which reopens the dialog with the
  input. A toast with an action already pauses while hovered (`UndoToastMessage`).
- Better still for create: after the content-tree refresh, look for a collection with that name
  under that parent. If it is there, report success; if not, the restore offer above applies.

## Done when

After an unanswered create or details save that did not land, the user can get back what
they entered without retyping it, with a test for each.
