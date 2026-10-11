---
priority: P3
adopters: BOTH
summary: >-
  `api/client.ts` sets no timeout or abort signal on its fetches, so a stalled request (network drop, laptop sleep) never settles. In the field comment popover (`editor/comments/CommentThreadsPopover.tsx`) a post or Resolve in flight holds the popover open with its focus trap, so a keyboard user cannot leave it until the browser gives up. Give editor writes a bounded timeout that rejects with a plain-words error, which the popover then shows and releases.
---

# Editor API requests have no timeout

## What is known

- `CommentThreadsPopover` counts writes in flight (`track`) and refuses to close while any is pending, so a reopened composer cannot post the same text twice and a failure stays in view.
- With no timeout in `api/client.ts`, a request that never answers keeps that count above zero: Escape, outside click and the control toggle are refused, and `trapFocus` keeps Tab inside the dropdown. A mouse user can still navigate away, which remounts the popover; a keyboard user is stuck.
- Every other editor write (save, branch actions) has the same unbounded wait, without the trap.

## Done when

Editor writes time out after a bounded wait with an error the caller shows, with a test that a stalled comment post releases the popover.
