# PR #106 review follow-ups (2026-07 baseline integration review)

Source: debshila's approving review of PR #106 (2026-07-20). The review's two
Medium-High findings (#1 FormRenderer focus loss, #2 client/server auth-mode
asymmetry) plus #3–#6 and the mechanical lows were fixed on the review branch;
this file records what was deliberately deferred and why.

## Design decisions for JP (from the review's "Questions for JP")

1. **`mode` defaults to `'dev'`** (`config/schemas/config.ts`): a prod deploy
   that omits `mode: 'prod'` silently runs header-trusting dev auth semantics,
   bypassing the SEC-C1 fail-closed guard. The CLI path guards this via
   `detectMode()`, but a hand-written config doesn't. Options: make `mode`
   required (no default), or warn loudly at startup when mode is defaulted.
2. **`isCreateScaffold` abandoned scaffolds** (`api/content.ts`): a new entry
   can persist in a schema-invalid empty state. Verify whether publish/static
   build re-validates (and rejects/skips) such entries, or whether an abandoned
   scaffold can ship to a static build. Add a build-time guard if not.
3. ~~**`CLERK_SECRET_KEY` required at module load in prod**~~ — DONE:
   `ClerkAuthPlugin` (`clerk-plugin.ts`) now defers `createClerkClient` and the
   secret-key resolution to first authenticated use (memoized), instead of
   constructing eagerly in the constructor. Construction stays cheap and
   never throws, so the zero-editor static build can import `canopy.ts` for
   reads without `CLERK_SECRET_KEY`. The fail-closed throw is preserved — it
   now fires at the first authenticated call instead of at module load.

## Defense-in-depth / refactors

4. ~~**`insecureDevOnly` is a denylist, not an allowlist**~~ — DONE: replaced
   with an affirmative `verifiesCredentials?: boolean` allowlist marker on
   `AuthPlugin` (`auth/plugin.ts`). `assertAuthPluginAllowedForMode` now
   rejects any prod plugin that doesn't set `verifiesCredentials: true`
   (absence fails closed). `insecureDevOnly` removed entirely; `DevAuthPlugin`
   intentionally omits the new marker, `ClerkAuthPlugin` sets it, and
   `CachingAuthPlugin`/`staticDeployAuthPlugin` forward/set it so wrapping
   can't launder an insecure plugin past the guard.
5. **Worker reimplements `createOrUpdatePR`** (`worker/cms-worker.ts` vs
   `github-service.ts`): two copies of the PR-idempotency logic can drift; the
   worker path also doesn't mark a pre-existing draft PR ready-for-review while
   the direct path does. Extract a shared helper both call.
6. **Octokit throttling plugin**: the 403 rate-limit fix classifies rate-limit
   403s as transient (retry with backoff); adding `@octokit/plugin-throttling`
   to the worker's Octokit would additionally respect `retry-after` timing
   proactively instead of relying on task-level retry.

## Editor lows (batch with the next editor pass)

7. **`CollectionEditor` catch is effectively dead** (`CollectionEditor.tsx`):
   `useSchemaManager` swallows errors and returns `false`, so the modal's
   inline error is always generic; the real reason only appears in a transient
   toast. Surface the real error to the modal.
8. **One-frame stale `fieldErrors` flash on entry switch**
   (`useDraftManager.ts` + `Editor.tsx`): errors are cleared by a post-commit
   effect while preview resets synchronously, so the new entry renders once
   with the previous entry's errors. Clear synchronously on entry switch
   (adjust-state-during-render pattern) or derive from currentId.
9. **Recompute effect omits `currentEntry` from deps** (`useDraftManager.ts`):
   errors validate against a stale schema if the entry type changes while the
   entry stays open. Needs care: `currentEntry` identity stability must be
   checked first or the effect could loop (setFieldErrors allocates a new map
   per run).

## Perf low

10. **Existence guard calls `idIndex()` inside the entry lock**
    (`content-store.ts`): if `invalidateIndex()` fired between warm-up and the
    guard, a full rescan runs while holding the lock. Latency-only; consider
    warming the index before taking the lock.

## Test-coverage gaps noted by the review

- `field-traversal` direct tests only cover the legacy inline-block shape, not
  the canonical `{template, value}` (covered only transitively today).
- `content-index-registry` prefix-match and `FinalizationRegistry` pruning are
  untested.
- (FormRenderer focus-retention regression test was added with the fix.)
