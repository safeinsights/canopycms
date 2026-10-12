---
priority: P3
adopters: BOTH
summary: >-
  The comments panel and the field comment popover refuse to close while a comment write is in flight, so their busy state and any error stay in view. `ApiClient.request` (`api/client.ts`) has no timeout, so a write that hangs (laptop sleep, network switch) holds the modal drawer open with no explanation, and the only way out is a reload that loses drafts. Options: a request timeout for comment writes, or the drawer's `keepMounted` with a toast for failures while hidden, plus a visible reason when a close is refused.
---

# A hung comment write holds the comments surface open

## What is known

- `CommentsPanel` and `CommentThreadsPopover` guard their close on `useTrackedWrites().inFlight`
  (`editor/comments/use-tracked-writes.ts`). Every Drawer close route (X, overlay, Escape) and
  the panel's jump buttons go through that guard.
- Nothing aborts a stalled request, so `inFlight` stays above zero until the browser gives up.
- Mantine 7.17.8's `ModalBase` supports `keepMounted`, which hides rather than unmounts the
  contents. With it the panel could close mid-write without losing state, but the hidden
  `resolve-thread-button` / `comment-thread` nodes would collide with page-wide e2e locators in
  `apps/test-app/e2e/fixtures/editor-page.ts`, which would need scoping.

## Done when

A stalled comment write cannot trap the user, and a refused close says why.
