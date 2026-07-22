# Fix e2e test race condition: ENOENT during workspace reset

## Problem

The e2e tests (`pnpm test:e2e`) pass but emit noisy `ENOENT` errors from the WebServer during test runs. The error occurs when the Next.js dev server tries to read `content/home.home.{id}.json` while the test's `beforeEach` hook is resetting the workspace (deleting and recreating content files).

The file is momentarily missing between deletion and recreation, and a concurrent page load from the dev server hits the gap.

Example error:

```
Error: ENOENT: no such file or directory, open '.../.canopy-dev/content-branches/main/content/home.home.127E9bFyLWac.json'
    at async ContentStore.read (content-store.ts:239)
    at async readContentHandler (api/content.ts:89)
```

The ID differs each run (freshly generated on reset), confirming it's a timing issue not a stale reference.

## Files

- `apps/test-app/e2e/` — test specs and fixtures (look at the `beforeEach` reset logic)
- `packages/canopycms/src/content-store.ts:239` — the `fs.readFile` that throws
- `packages/canopycms/src/api/content.ts:89` — the read handler that surfaces the error

## Suggested approach

1. Check how the workspace reset works in the e2e test fixtures — does it delete-then-recreate, or is there an atomic swap?
2. Options to fix:
   - Make the reset atomic (write new content before removing old)
   - Add a "not found during reset" grace period or retry in the content read handler
   - Pause/block dev server requests during reset (e.g., a health check gate)
   - Simply catch ENOENT in the read handler and return a 404 response instead of throwing (this may be the right fix regardless — an unhandled ENOENT shouldn't crash the request)
3. Verify the error is truly pre-existing by checking `git stash && pnpm test:e2e` on main
