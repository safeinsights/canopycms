---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-10, parked by the editor UI/UX epic. Collection management (the "schema editor": create and edit collections, choose code-defined entry types) stacks up to three modals: CollectionEditor, then EntryTypeEditor, then a Remove confirm. Redesign as one drawer with inline entry-type editing. Admin-only, so not launch-critical
---
# Collection management: one surface instead of stacked modals

The epic ([ui-epic-202610.md](ui-epic-202610.md), section G) fixes only the correctness bug
(entry-type changes save immediately even inside a dialog with Cancel) and gates the UI to
admins. The visual redesign is this task:

- `schema-editor/CollectionEditor.tsx` opens `EntryTypeEditor.tsx` as a modal on top of itself,
  and Remove opens a third modal.
- Target: a right drawer (like Branches and Permissions) with the collection's fields at the
  top and entry types as an inline editable list, saved together.
- Fields themselves stay defined in code; this UI never edits them.
