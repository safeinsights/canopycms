---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-12. UX follow-ups for comment threads on a removed list item or block, from the UX
  review of the `_key` change: the Remove toast doesn't say the item's comments moved to the entry,
  a removal still only in the draft could name the item from the saved value, no Storybook story
  shows the removed-item states, and the UX guidelines say nothing about comments whose anchor
  disappears
---

# Removed-item comment threads: UX follow-ups

**Status:** Open. **Priority: P3.** Filed 2026-10-12 from the UX review of the change in
[comment-threads-anchor-to-list-index.md](resolved/comment-threads-anchor-to-list-index.md).

A field thread whose list item or block is gone shows in "Comment on this entry", with an "On a
removed item" badge and the field's schema breadcrumb, without the item (`EntryComments`,
`InlineCommentThread`'s `fieldLabel`, `CommentsPanel`).

## Items

1. **Say so on Remove.** The Undo toast (`editor/components/UndoToastMessage.tsx`) reads
   `Removed "Typed" from Features`. The item's open threads leave the field silently; the only
   sign is the entry button's count going up. When the removed item had threads, add e.g.
   `Its comment moved to "Comment on this entry".`, with agreed plurals.
2. **Name the item while the removal is only in the draft.** Every removed-item thread reads
   "Features › Title". While the item's key is still in the saved value (`loadedValue`), the
   breadcrumb could name it from there ("Features › Typed › Title"). After a save it can't, unless
   the thread stores the item's title when it is made.
3. **Stories.** Add `RemovedItemThread` stories to `CommentsPanel.stories.tsx` and
   `FormRenderer.stories.tsx` (badge and breadcrumb in the entry popover; the panel card with
   "Jump to entry"), and one for the composer blocked on an unsaved item (the note, plus "Comment"
   `aria-disabled` with its Tooltip).
4. **Guideline gaps in `docs/ux-guidelines.md`:**
   - where a comment whose anchor disappears goes, how it is labelled, and whether the action
     that moved it says so;
   - "Disabled says why" for an action blocked only by unsaved state: show the reason first,
     allow drafting, disable only the submit (what the comment composer now does);
   - whether Mantine Badge's uppercase styling is exempt from sentence case.
5. **Seen in passing, not from this change:** the "Unresolved" badge in
   `editor/comments/InlineCommentThread.tsx` is orange text on an orange tint, about 2.6:1. It
   should take `c="var(--mantine-color-text)"` like the "On a removed item" badge beside it.
