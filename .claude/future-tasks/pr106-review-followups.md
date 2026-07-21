# PR #106 review follow-ups (2026-07 baseline integration review)

Source: debshila's approving review of PR #106 (2026-07-20). The review's two
Medium-High findings (#1 FormRenderer focus loss, #2 client/server auth-mode
asymmetry) plus #3–#6 and the mechanical lows were fixed on the review branch;
this file records what was deliberately deferred and why. All remaining
items below were subsequently resolved on branch `fix/pr106-review-followups`
(2026-07-20); this file now serves as the record of what was done.

## Design decisions for JP (from the review's "Questions for JP")

1. ~~**`mode` defaults to `'dev'`**~~ — DONE: mode is now required in the
   config schema (no default); omitting it fails validation loudly. Test
   helper `defineCanopyTestConfig` defaults it for fixtures.
2. ~~**`isCreateScaffold` abandoned scaffolds**~~ — DONE: verified nothing
   re-validated on publish/static build; added a build-time guard —
   `collectStaticPaths` (isBuildMode-gated) and `generateAIContentFiles`
   (unconditional) now throw, listing every schema-invalid entry. Publish
   stays permissive.
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
5. ~~**Worker reimplements `createOrUpdatePR`**~~ — DONE: extracted a shared
   `createOrUpdatePullRequest` in `github-service.ts`; the worker now
   delegates to it and converts pre-existing draft PRs to ready via a
   `markReadyIfDraft` payload flag (set by content submits, not settings
   syncs).
6. ~~**Octokit throttling plugin**~~ — DONE: `@octokit/plugin-throttling@^8`
   via a `createCanopyOctokit` factory used by both `GitHubService` and
   `CmsWorker`; the manual 403 classification is retained as a safety net.

## Editor lows (batch with the next editor pass)

7. ~~**`CollectionEditor` catch is effectively dead**~~ — DONE:
   `useSchemaManager` now returns result objects instead of swallowing errors
   into a boolean, so the modal shows the real error instead of a generic
   message.
8. ~~**One-frame stale `fieldErrors` flash on entry switch**~~ — DONE:
   `fieldErrors` are now keyed by entry id and derived rather than
   imperatively cleared, so there is no stale-error flash on entry switch.
9. ~~**Recompute effect omits `currentEntry` from deps**~~ — DONE: the
   recompute effect's deps now include schema/format, guarded by a
   functional updater plus a shallow-equal bail to avoid the identity-churn
   loop the original note warned about.

## Perf low

10. ~~**Existence guard calls `idIndex()` inside the entry lock**~~ — DONE:
    `write()`'s existence guard now reads the live index synchronously
    instead of awaiting `idIndex()` under the entry lock; any staleness errs
    toward `ContentConflictError` instead of blocking on a rescan while
    holding the lock.

## Test-coverage gaps noted by the review

- ~~`field-traversal` direct tests only cover the legacy inline-block shape,
  not the canonical `{template, value}` (covered only transitively
  today).~~ — CORRECTED: this was already covered by
  `validation/__tests__/field-traversal.test.ts:299-424` (the canonical
  `{template, value}` describe block); no work was needed.
- ~~`content-index-registry` prefix-match and `FinalizationRegistry` pruning
  are untested.~~ — DONE: dedicated test file added
  (`content-index-registry.test.ts`).
- (FormRenderer focus-retention regression test was added with the fix.)
