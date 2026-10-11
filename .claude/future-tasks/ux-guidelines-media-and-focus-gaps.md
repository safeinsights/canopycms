---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-11, from WS7a-1's UX review. docs/ux-guidelines.md is silent on five things the media library had to decide: the word for a library item, where focus goes when its control disappears, live-region etiquette for background progress, not reordering content under the pointer, and the confirm-vs-undo rule for a reversible-in-principle "Remove from library"; plus the confirm modal's close button has no accessible name
---
# Guideline gaps found while building the media library search

Each of these was decided locally in `packages/canopycms/src/editor/media/`; the guideline
should state the rule so other surfaces decide the same way.

1. **Vocabulary for library items.** The table has no row for media items. The media library
   now says "file" ("Loaded 40 files", "No files match"), while "asset" stays internal. Add the
   row (file; not asset, media item).
2. **Focus when the opener is gone.** Keyboard covers returning focus to an overlay's opener,
   not what happens when that control was removed (a deleted card's trash button) or hid
   itself (a search's clear button). The media library sends focus to the search field.
3. **Background progress.** A `role="status"` region whose text changes on every page floods a
   screen reader. The rule: announce phase changes (started, finished, result count), keep
   running counts visual only.
4. **Content arriving in the background.** Never reorder content under the pointer while it
   loads; append, then re-sort once on completion or on a control change.
5. **Library removal.** "Remove from library" hides a stored item but destroys nothing, and
   there is no restore UI. The rules split confirm (destroy or publish) from Undo (in-form
   removal), and this fits neither; say which applies (today: a modal confirm).
6. **Code fix, not guideline:** `openConfirm`'s modal (`packages/canopycms/src/editor/utils/confirm-modal.ts`)
   renders its close button with no accessible name. Pass `closeButtonProps: { 'aria-label': 'Close' }`
   there so every confirm gets it.
