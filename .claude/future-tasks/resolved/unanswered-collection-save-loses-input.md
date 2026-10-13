---
priority: P3
adopters: BOTH
summary: >-
  RESOLVED (2026-10-13). `Editor.tsx` keeps an unanswered collection create or details save as a `CollectionDraft` (`schema-editor/collection-draft.ts`). The next "New collection" under that parent, or that collection's Edit, fills it in again with a "Discard changes" way out; when the dialog's opener reads a fresh tree that shows the write landed, the draft goes and a green toast says so; a create no read has ruled out is not refilled
---

# An unanswered collection create or details save loses what was entered

## Status: RESOLVED 2026-10-13

Tests: `Editor.admin-and-undo.test.tsx` ("a collection write with no answer") and `CollectionEditor.test.tsx` ("input restored after a write with no answer").

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

## Fix

[docs/ux-guidelines.md](../../../docs/ux-guidelines.md#loading-empty-and-error-states) rules that a
create closed after no answer prefills that dialog's next open with what was typed. Keep the
staged `CreateCollectionInput` (or the details update) in `Editor.tsx` and prefill the dialog
the next time "New collection" (or that collection's Edit) opens for the same parent, with a way
to discard it. For create, first look for a collection with that name under that parent after
the content-tree refresh: if it is there, report success instead.

## Done when

After an unanswered create or details save that did not land, the user can get back what
they entered without retyping it, with a test for each.
