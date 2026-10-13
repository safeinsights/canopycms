---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-12. Follow-ups from the `_key` item-key change: React keys could use `_key`
  instead of `useListItemKeys`' identity heuristics; custom field renderers that copy list items
  have no exported way to give the copy fresh keys; `useCommentSystem`'s `activeThreads` and
  `CommentStore.getThreadsForField` still match threads by stored path and have no consumers;
  an optional backfill CLI could write keys into every entry at once
---

# Follow-ups from list-item keys

**Status:** Open. **Priority: P3.** Filed 2026-10-12 from the design review of
[comment-threads-anchor-to-list-index.md](resolved/comment-threads-anchor-to-list-index.md).

## Items

1. **React keys from `_key`.** `editor/fields/list-item-keys.ts` (`useListItemKeys`) infers item
   identity from object identity and position. Every item now carries a persisted `_key`
   (`item-keys.ts`), and the editor keys any item that lacks one in its draft setter, so
   `useListItemKeys` could read `_key` and drop its heuristics. Check expansion state
   (`item-expansion.ts`) and Undo focus, which key off it.
2. **Custom renderers that copy items.** A custom renderer for an `object` or `block` field that
   duplicates an item copies its `_key`. The draft setter keeps the first item holding a key, so
   a copy inserted ABOVE its original takes the original's key and its comment threads. Exporting
   `withFreshItemKeys` and `mintItemKey` would let a renderer do it right, but that adds public
   API, so it needs approval. A renderer that rebuilds items without `_key` (`items.map((i) => ({ title: i.title }))`)
   gets a new random key on every change, so their threads read as on a removed item and keyed
   YAML comments on them are dropped. Keeping the previous key for an item at the same index that
   arrives without one would cover that.
3. **Dead path-matching code.** `useCommentSystem`'s `activeThreads`/`activeCommentContext` and
   `CommentStore.getThreadsForField` match field threads by their stored `canopyPath`. That path
   is only where the thread's items were when it was made. Neither has a consumer outside tests,
   so delete them (or resolve them through `resolveThreadPath`).
4. **Optional backfill CLI.** Reads key un-keyed items from a hash of their content, and the first
   save writes the keys down, so a backfill isn't needed for correctness. It would make the
   one-time diff a single deliberate commit rather than one per entry as it is edited.
