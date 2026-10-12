---
priority: P2
adopters: BOTH
summary: >-
  New 2026-10-12. Field comment threads anchor to an index path (`team[1].name`), so reordering, Duplicate, insert-between, Remove or a block move leaves a thread on whichever list item now holds that index. Anchor threads to a stable list-item id, or remap thread paths when items move
---

# Field comment threads follow the list index, not the list item

**Status:** Open. **Priority: P2.** Filed 2026-10-12 from the final review of the editor UI
epic's phase 3.

## State

A field comment thread stores the field it belongs to as `canopyPath`
(`packages/canopycms/src/comment-store.ts`), an index path such as `team[1].name` or
`blocks[2].title`. Nothing updates that path when the list under it changes, so after any of
these the thread shows on whichever item now sits at that index:

- Move up, Move down and drag reordering in object lists and block lists
  (`editor/fields/ItemList.tsx`, `ObjectListField.tsx`, `BlockField.tsx`);
- Duplicate and insert-between, which shift every later item down one;
- Remove, which shifts every later item up one, and leaves a thread on the last index
  pointing at nothing.

A reviewer's comment about one team member then appears against another, which reads as the
reviewer having said something they did not.

## Fix direction

Either:

1. **Anchor to a stable item id.** Give each list item and block a persisted id and store the
   thread's path in terms of it (`team[id=…].name`). Needs a content-format decision: where
   the id lives in MD/MDX front matter and JSON, and how existing content without ids gets
   them.
2. **Remap on move.** When a list or block operation lands in a draft, rewrite the
   `canopyPath` of every thread under that list. Cheaper, but the rewrite has to reach the
   comment store when the entry saves, and a draft discarded afterwards must undo it.

Option 1 is the durable one; option 2 keeps the content format unchanged. Either way, a thread
on a removed item needs a home: keep it on the entry, marked as on a removed item.

## Done when

A thread stays on the same item through a reorder, a Duplicate above it, an insert above it
and the removal of an item above it, in both object lists and block lists, with a test for
each.
