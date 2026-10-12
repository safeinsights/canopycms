---
priority: P3
adopters: BOTH
summary: >-
  RESOLVED (2026-10-12) — a hung comment write is bounded by the API client's request deadline (see [api-client-no-request-timeout.md](api-client-no-request-timeout.md)), so the comments panel and field popover always release. A close they refuse while a write is in flight now says why: `useTrackedWrites().guardClose` sets `closeRefused`, shown as a status line in the drawer title and the popover.
---

# A hung comment write holds the comments surface open

## Status: RESOLVED 2026-10-12 — bounded by the request deadline; a refused close says why

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
