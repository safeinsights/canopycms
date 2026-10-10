---
priority: P3
adopters: KB
summary: >-
  Resolved comment threads are **terminal** — `comment-store.ts:219-227` has `resolveThread` and no inverse anywhere in the store, API or UI, and both thread components hide Reply once resolved with no counterpart action. Add the unresolve primitive (store + API + UI). Promoted from P3: comments are the KB's daily review mechanism and a mis-click is currently unrecoverable
---
# Allow Unresolving a Resolved Comment Thread

Resolved comment threads are terminal today: the panel hides Reply on resolved threads and offers no way to reopen one resolved by mistake (observed in the 2026-07-24 deployed-editor UX review; see [resolved/ux-review-deploy-test-findings.md](resolved/ux-review-deploy-test-findings.md)).

## What's missing

- `comment-store.ts` has `resolveThread(threadId, userId)` (hard-sets `resolved: true`, `resolvedBy`, `resolvedAt`) but no inverse.
- `api/comments.ts` exposes only `list` / `add` / `resolve` (`POST /:branch/comments/:threadId/resolve`, guard `branchAccess`).

## Proposed shape

- `comment-store.ts`: `unresolveThread(threadId, userId)` — clears `resolved/resolvedBy/resolvedAt` under the same OCC write helper; consider recording `reopenedBy/reopenedAt` for the audit trail.
- API: either `POST .../unresolve` or make resolve accept `{ resolved: boolean }`. Either way it applies resolve's thread read gate (`canReadThreadEntry` in `api/comments.ts`): a thread on an entry the user cannot read answers 404.
- UI: "Unresolve" action on resolved threads (CommentsPanel + InlineCommentThread), gated by the same `canResolve` permission.

Deferred from the UX-fix branch because it adds API surface (kept that branch to behavior fixes only).
