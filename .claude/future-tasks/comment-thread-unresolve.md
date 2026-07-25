# Allow Unresolving a Resolved Comment Thread

Resolved comment threads are terminal today: the panel hides Reply on resolved threads and offers no way to reopen one resolved by mistake (observed in the 2026-07-24 deployed-editor UX review; see [resolved/ux-review-deploy-test-findings.md](resolved/ux-review-deploy-test-findings.md)).

## What's missing

- `comment-store.ts` has `resolveThread(threadId, userId)` (hard-sets `resolved: true`, `resolvedBy`, `resolvedAt`) but no inverse.
- `api/comments.ts` exposes only `list` / `add` / `resolve` (`POST /:branch/comments/:threadId/resolve`, guard `branchAccess`).

## Proposed shape

- `comment-store.ts`: `unresolveThread(threadId, userId)` — clears `resolved/resolvedBy/resolvedAt` under the same OCC write helper; consider recording `reopenedBy/reopenedAt` for the audit trail.
- API: either `POST .../unresolve` or make resolve accept `{ resolved: boolean }`.
- UI: "Unresolve" action on resolved threads (CommentsPanel + InlineCommentThread), gated by the same `canResolve` permission.

Deferred from the UX-fix branch because it adds API surface (kept that branch to behavior fixes only).
