# `utils/` — Shared utilities

Cross-cutting helpers. Several exist specifically because two call sites had drifted into disagreeing implementations.

Split out of the root [AGENTS.md](../../../../AGENTS.md) on 2026-08-23, where this had grown to
601 words inside a single bullet. The **code comment at the point of the rule is
authoritative**; this file is the map to where those rules live.

## Overview

Shared utilities (error handling, debug, atomic file writes, `content-serialize.ts` - `serializeYaml`/`serializeFrontmatter`, the comment-preserving write path: `ContentStore.write` re-serialises onto the file's OWN parsed `yaml` document rather than a fresh one, so unchanged nodes keep their comments (writing a fresh object silently deleted every comment in a content file on every editor save). It stays schema-blind — the document's key set is made to match `input.data` exactly, so data authority stays with the payload and comments are the only thing inherited from disk. Sequences align by VALUE then position, so a reorder carries each comment with its content. Position alone never pairs two records: `looksLikeSameItem` demands a surviving field value, and that search is deliberately discriminator-BLIND and record-DEEP (via `validation/block-structural-keys.ts`) — shallow-and-discriminator-counting is what let a save that deleted one block and edited its successor migrate the deleted block's comment onto the survivor, the module's own stated worst outcome. Both halves are required together: excluding `template` without descending into `value` would instead drop every block comment on every edit. Two more rules that are load-bearing: every fallback (new file, unparseable bytes, no frontmatter) must emit the exact pre-fix output, and the md/mdx split must call `matter(raw, {})` WITH an options object — gray-matter's no-options path uses a process-global content-keyed cache whose hit returns an object with `.matter` missing, which made this a preserve-on-first-save/drop-on-every-save-after bug; title-field: `resolveEntryTitle` — client-safe (type-only dependency), exported from both `canopycms/server` and the root `canopycms` entry — plus `findInvalidTitleFields`, `findTitleFieldsInLists`)

## `git.ts`

dependency-light git helpers (`isNetworkRemoteUrl`, `detectHeadBranch`/`resolveBaseBranch`, `isNonFastForwardRejection` — the push-rejection classifier shared by api/branch-status.ts's 409 path and worker/task-runner.ts's fail-fast `PermanentTaskError` path; depends on `git-manager.ts`'s `gitChildEnv` forcing `LC_ALL=C`/`LANG=C` so git's rejection text stays English; `isRebaseInProgress(repoPath)` — fs-only (no subprocess), never-throws check for an interrupted rebase (`.git/rebase-merge`/`rebase-apply`, resolving a `.git` FILE pointer as well as a directory), shared by worker/rebase.ts's rebase recovery and branch-health.ts's admin scan so the two cannot disagree about what "mid-rebase" means)

## `url-prefix.ts`

THE shared URL-prefix join (`joinUrlPrefix`, plus `isAbsoluteUrl` and `stripTrailingSlashes`, which moved here from `static/seo.ts` and are re-exported from it so `canopycms/server`'s surface is unchanged). Used by BOTH `static/seo.ts`'s `resolveSeoUrl` and `assets/asset-url.ts`'s `assetUrl`, which had drifted into two implementations — the asset copy checked neither the absoluteness of the path (so an off-site src became `/prefix/https://cdn…/x.png`) nor the shape of the prefix (so a prefix with no leading slash produced a document-relative URL resolving differently per page). Must stay pure — it is reachable from client bundles via `asset-url.ts`, its only import is `sanitize-href.ts`, and `pnpm lint:bundle` enforces that

## `occ-json-write.ts`

shared OCC JSON write helper (`writeOccJsonFile`, `withOccRetry`, `withOccFileLock`) adopted by comment-store.ts and branch-metadata.ts

## `provisioning-lock.ts`

`acquireProvisioningLock`/`tryAcquireProvisioningLock`; both anchor proper-lockfile on the lock MARKER's own path (not its parent directory) because proper-lockfile keys its in-process `locks{}` registry — refresh timer and release fn — by that target path, so anchoring two branches on a shared branches root aliased them into one entry (releasing one broke the other's release with `ERELEASED` and leaked its lock dir, whose orphaned refresh timer then crashed the process with `ECOMPROMISED`); both also pass an `onCompromised` that logs rather than proper-lockfile's default rethrow-from-a-timer, which is an uncaught exception

## `content-write-lock.ts`

[SYNC-C1] cross-host exclusion between content writes and the worker's rebase loop, marker kept under `{branchRoot}/.canopy-meta` (per-branch, and git-excluded so it can't dirty the working tree); it anchors on that marker path like every other lock, so it cannot alias the branch's provisioning lock. Used ASYMMETRICALLY: `ContentStore.write`/`delete`/`renameEntry` wait briefly then throw `BranchSyncingError` (a `ContentConflictError` subclass → existing 409 mapping), `rebaseActiveBranches` acquires with zero retries and skips the branch (`skippedLocked`) because it retries every cycle. Reads must never take it — see [docs/concurrency.md](../../../../docs/concurrency.md)
