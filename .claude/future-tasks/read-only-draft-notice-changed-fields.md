---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-10, from the editor UI epic's WS3 UX review. ReadOnlyDraftNotice and its Discard confirm say an entry has unsaved changes but not which fields; list them by label path ("Features › Features #1 › Title") so the user knows what Discard destroys
---
# Name the changed fields in the read-only draft notice

`components/ReadOnlyDraftNotice.tsx` tells a reader that an entry on a read-only branch has a
kept draft, and offers Discard changes. The draft itself is not shown, so neither the notice nor
the confirm modal (`handleDiscardFileDraft` in `hooks/useDraftManager.ts`) can say what will be
lost. docs/ux-guidelines.md asks a destructive confirm to name the thing.

## Fix

Diff the kept draft against the loaded value by field and list the changed fields with human
labels (the labelled-breadcrumb helper the validation summary is meant to use, plan row C6).
