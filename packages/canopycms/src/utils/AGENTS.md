# `utils/` — Shared utilities

Cross-cutting helpers, several of them consolidating two call sites that had drifted apart.
The code comment at the point of a rule is authoritative; this file maps only the rules that
span files.

## Where each rule lives

- `content-serialize.ts` (module header, `looksLikeSameItem`): the comment-preserving write
  path `ContentStore.write` uses; its evidence search reads `validation/block-structural-keys.ts`.
- `content-write-lock.ts` (module header): [SYNC-C1]; taken by `ContentStore.write`/`delete`/
  `renameEntry` (mapped to `BranchSyncingError`) and by `rebaseActiveBranches`; reads never take
  it. Layering: [docs/concurrency.md](../../../../docs/concurrency.md).
- `entry-url.ts` (`isIndexSlug`): the one index-slug decision; `computeEntryUrl`,
  `content-tree.ts`, `content-reader.ts`, the editor preview, `resolveUrlPathCandidates` and
  `canopycms-next` all route through it.
- `error.ts` (`sanitizeErrorMessage`): owns the `[REDACT]` tag; grep it for every site that
  serves raw error text to a browser.
- `git.ts` (each predicate's comment): `isNonFastForwardRejection` serves api/branch-status.ts
  and worker/task-runner.ts and needs git-manager.ts's `LC_ALL=C`; `isRebaseInProgress` serves
  worker/rebase.ts and branch-health.ts.
- `logger.ts` (module header): `canopyLog*` for code that runs in both the worker and Lambda;
  worker/log.ts owns the timestamp invariant.
- `occ-json-write.ts` (module header): OCC JSON writes for comment-store.ts and
  branch-metadata.ts.
- `provisioning-lock.ts` (`provisioningLockOptions`): every lock anchors proper-lockfile on its
  own marker path, so two locks never alias one registry entry.
- `sanitize-href.ts` (`declaresScheme`): the one statement of the WHATWG backslash-equals-slash
  rule; every off-site check routes through it.
- `title-field.ts` (`resolveEntryTitle`): client-safe; exported from both `canopycms/server`
  and the root entry.
- `typed-filename.ts` (`parseTypedFilename`): lives here so url-collision.ts can reach it
  without a cycle; re-exported by content-listing.ts and `canopycms/server`.
- `url-prefix.ts` (`joinUrlPrefix`, `isAbsoluteUrl`): the one URL-prefix join for
  static/seo.ts and assets/asset-url.ts; must stay pure (client-reachable, `pnpm lint:bundle`
  enforces it).
