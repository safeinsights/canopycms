---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-10, from the editor UI epic's WS3 review. A draft kept on an entry the user can no longer edit (`canEdit === false`) is counted as unsaved but has no notice or Discard, and a late async edit is dropped by the current entry's lock rather than its own
---
# Kept drafts on an entry the user can no longer edit

`Editor.tsx`'s `contentReadOnly` covers both a locked branch and an entry with
`canEdit === false`. Two edge cases remain for the second:

1. **No way to discard.** `ReadOnlyDraftNotice` renders only above the form, and
   `NoEditPermissionNotice` replaces the form when `canEdit === false`. A draft written before
   an admin tightened a path rule still counts in `resolveUnsaved` and `editedFiles`, so a
   branch switch warns about unsaved work the user can neither see nor discard from the pane
   ("Discard all" in the branch menu still works). Either show the notice alongside
   `NoEditPermissionNotice`, or leave such entries out of the unsaved count.
2. **Late edits judged by the wrong entry.** The draft writer's `contentId` comes from the
   render that created the callback, while `contentReadOnlyRef` is read when it is called. An
   image upload started on editable entry A that finishes after the user opens entry B, where
   `canEdit === false`, is dropped although A could take it. The branch-level case is right,
   since that lock is global. A fix would key the ref by content id.
