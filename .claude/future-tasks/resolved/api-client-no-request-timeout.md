---
priority: P3
adopters: BOTH
summary: >-
  RESOLVED (2026-10-12) — every generated client call runs under a deadline (`api/request-deadline.ts`): 30 s for reads, 75 s for writes, 180 s for endpoints declared `clientTimeout: 'long'`, and a per-call `timeoutMs`/`signal` through `RequestOptions`. Past it the call rejects with `ApiTimeoutError`. Save treats a timeout as outcome-unknown, a timed-out comment post says it may have landed and reloads the threads, timed-out branch actions reload the branch list, and the content and branch load toasts offer Retry.
---

# Editor API requests have no timeout

## Status: RESOLVED 2026-10-12 — request deadlines in the generated client

## What is known

- `CommentThreadsPopover` counts writes in flight (`track`) and refuses to close while any is pending, so a reopened composer cannot post the same text twice and a failure stays in view.
- With no timeout in `api/client.ts`, a request that never answers keeps that count above zero: Escape, outside click and the control toggle are refused, and `trapFocus` keeps Tab inside the dropdown. A mouse user can still navigate away, which remounts the popover; a keyboard user is stuck.
- Every other editor write (save, branch actions) has the same unbounded wait, without the trap.

## Done when

Editor writes time out after a bounded wait with an error the caller shows, with a test that a stalled comment post releases the popover.
