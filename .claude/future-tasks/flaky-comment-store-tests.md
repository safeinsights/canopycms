# Investigate flaky concurrent tests in comment-store.test.ts

## Problem

The two concurrent tests (`handles concurrent resolveThread calls` and `handles concurrent deleteThread calls`) are flaky and currently have `{ retry: 1 }` as a workaround. Root cause is likely filesystem timing in concurrent file writes.

## Files

- `packages/canopycms/src/comment-store.test.ts` (lines ~357, ~389)

## Suggested approach

Investigate whether the underlying `CommentStore` has a race condition in concurrent writes, or whether the test assertions need to account for non-deterministic ordering.
