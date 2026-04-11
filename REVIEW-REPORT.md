# CanopyCMS Baseline Review Report

**Date:** 2026-04-11
**Branch reviewed:** `e2e-additions-20260410`
**Methodology:** 10 parallel review agents covering security, API, content store & git, schema/validation, client/server boundary, operating modes, editor UI, and codebase hygiene; plus main-Claude triangulation and spot-check verification of all Critical/High findings.

---

## Executive Summary

CanopyCMS has a coherent overall architecture — authentication is centralized, route dispatch is declarative, the guard system is well-designed, and git operations use `simple-git` in array-arg form throughout (no shell injection found). The TypeScript build is clean (0 type errors), lint is nearly clean (3 warnings), and 1830 tests pass.

However, the codebase has four confirmed **Critical** production bugs that will cause data loss under normal usage: concurrent edits on the same branch silently last-writer-wins (no per-file locking), the content-ID index is a stale permanent snapshot after any git sync (causing wrong-file saves), a path traversal vulnerability in the asset store allows any authenticated user to list files outside the asset directory, and branch switches in the editor silently discard unsaved work from non-selected entries. There are also a dozen **High** findings including permission bypasses on two API endpoints, missing `'use client'` directives on four exported React components, and git conflict handling that leaves branch workspaces in permanently broken states. These issues are fixable in focused patches; the architecture does not need rethinking.

---

## Compound Findings

Issues where findings from multiple independent review agents touch the same code path, compounding severity.

### COMPOUND-1 — Asset store path traversal (confirmed by Security + Content Store agents)

Both agents independently identified the same root cause at `packages/canopycms/src/asset-store.ts:44`. The `LocalAssetStore.resolvePath` check `resolved.startsWith(this.root)` is insufficient: if `this.root = /var/canopy/assets`, a sibling directory `/var/canopy/assets-backup` would pass (`assets-backup` starts with `assets`). Any authenticated user can call `GET /assets?prefix=../assets-backup` and read the directory listing. Privileged users can upload to arbitrary locations. The `content-store.ts` implementation of the same pattern correctly uses a trailing-separator variant (`rootWithSep` at line 178), making this a localized deviation from an established fix.

**Fix:** In `LocalAssetStore.resolvePath`, change line 44 to:

```ts
const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep
if (resolved !== this.root && !resolved.startsWith(rootWithSep)) {
  throw new Error('Path traversal detected')
}
```

Apply the same fix to the `list`, `upload`, and `delete` paths (all share `resolvePath`). Also add an early-exit that rejects keys containing `..` segments.

---

### COMPOUND-2 — ContentId index stale + editor async data races compound on git sync

**Content Store agent** (High): `content-store.ts:108` — `indexLoaded` is set to `true` on first call and never reset. After `pullBase`, `pullCurrentBranch`, `checkoutBranch`, or `rebaseOntoBase` rewrites the working tree, the server continues serving entry IDs from the pre-operation state indefinitely (until process restart). In Lambda/warm containers this is permanent.

**Editor agent** (Medium): `useEntryManager.ts:323-340` — `refreshEntries` on branch change has no generation counter; a slow response from before the branch switch can overwrite the new branch's entry list.

**Together:** After a git sync, the server returns stale entry IDs via its stale index; simultaneously the editor may be holding a response from an even-older state. A user who opens an entry and saves will be operating on the wrong content-ID mapping — their save goes to the wrong file with no error. In the multi-worker prod deployment (EFS) this is a silent data corruption vector active every time any branch is synced.

**Fix (Content Store):** `GitManager` should emit an event or call a `contentStore.invalidateIndex(branchRoot)` method after any operation that rewrites the working tree. The `indexLoaded` flag must be cleared on those events. **Fix (Editor):** Add a generation token to `refreshEntries`; discard any response that arrives for a superseded generation.

---

### COMPOUND-3 — Worker `stop()` incomplete + git operations leave workspace dirty on conflict

**Operating Modes agent** (Medium): `worker/cms-worker.ts:260-276` — three concurrent `scheduleLoop` calls all write to `this.currentOperation`; `stop()` only `await`s whichever one wrote last. On spot-instance termination (SIGTERM), any in-flight git operation that wrote earlier is abandoned without await or abort.

**Content Store agent** (High): `git-manager.ts:520-535` — `pullBase`/`merge`/`rebaseOntoBase` do not catch conflict errors. `simple-git` throws, but the repo is left with `.git/MERGE_HEAD` and `<<<<<<<` markers. There is no `git merge --abort` / `git rebase --abort` in the catch path.

**Together:** On a spot-instance termination mid-merge, the worker's `stop()` does not wait for the git operation (compound), and the git operation itself does not abort on conflict. The EFS branch workspace is permanently in a broken mid-merge state requiring manual intervention. The next startup finds the conflicted repo, and any subsequent git operation fails. No operator-visible error is raised before the instance goes away.

**Fix:** Track all active operations in a `Set<Promise<void>>` and `await Promise.allSettled([...this.activeOperations])` in `stop()`. Wrap all `git.merge()` / `git.rebase()` calls; on error call `git merge --abort` or `git rebase --abort` and re-throw a typed `GitConflictError`.

---

### COMPOUND-4 — Schema mutations bypass guard system + ContentStore has no write lock

**API agent** (Critical): Schema mutation endpoints (`createCollection`, `updateCollection`, `deleteCollection`, `addEntryType`, `updateEntryType`, `removeEntryType`) all use `guards: ['admin']` only. Their handlers call `getSchemaOps(ctx, params.branch)` which calls `ctx.getBranchContext(branchName)` directly, bypassing the guard-provided `branchContext` and any branch-level ACL check.

**Content Store agent** (Critical): `ContentStore.write()` has no per-branch or per-path lock. Concurrent requests race and last-writer-wins.

**Together:** An admin triggering a schema-structure change (e.g., renaming an entry type) races with an editor writing content under the old schema on the same branch. Neither operation locks. The schema change can proceed while a content write is mid-flight, and the written document may be validated/pathed under the wrong schema. With no OCC token on writes, the content save succeeds silently with a now-invalid schema state.

---

## Critical / High Findings

All findings below were spot-checked against the actual source before inclusion.

---

### CRIT-1 — ContentStore concurrent writes have no per-branch lock

**File:** `packages/canopycms/src/content-store.ts:424–530`

`ContentStore.write()` is async and non-reentrant. Two concurrent requests editing different fields of the same entry on the same branch both read → build → `atomicWriteFile`. The atomic rename protects file bytes but the interleave causes silent last-writer-wins data loss. No version/etag/optimistic-concurrency (OCC) check exists. In the documented prod deployment (EFS + multiple editors), this is a real concurrent data loss scenario.

**Fix:** Add an in-process lock keyed by `absolutePath` (reuse the `withFileLock` helper from `branch-metadata.ts`) and an OCC token (mtime or content hash) passed through `write()` so cross-process races are detected and rejected with 409. The `BranchMetadataFileManager.write` versioning implementation is the right template.

---

### CRIT-2 — ContentId index is a permanent stale snapshot after git operations

**File:** `packages/canopycms/src/content-store.ts:108, 120–126`

`indexLoaded` is set `true` on first load and never reset. After any git operation that rewrites the working tree (`pullBase`, `pullCurrentBranch`, `rebaseOntoBase`, `checkoutBranch`), the in-memory index reflects the pre-operation state. In a long-lived Next.js server process or warm Lambda container, this is permanent. Multi-worker prod deployments each hold their own stale snapshot; an entry created by worker A is invisible to worker B until its process restarts.

**Fix:** Add `contentStore.invalidateIndex()` (clears `indexLoaded`). Call it from `GitManager` after any operation that changes working-tree content. Add similar invalidation in `BranchWorkspaceManager` after workspace initialization.

---

### CRIT-3 — Asset store path traversal (see also COMPOUND-1)

**File:** `packages/canopycms/src/asset-store.ts:44`

`resolvePath` check `resolved.startsWith(this.root)` without a trailing separator allows escape to sibling directories. `GET /assets` has no auth guard — any authenticated user can enumerate files outside the asset root by passing a crafted `prefix`. Fix described in COMPOUND-1.

---

### CRIT-4 — Editor branch switch silently discards unsaved drafts of non-selected entries

**Files:** `packages/canopycms/src/editor/hooks/useBranchActions.tsx:62`, `packages/canopycms/src/editor/hooks/useDraftManager.ts:95`

`confirmIfDirty` calls `options.isSelectedDirty()` which checks only the **currently open** entry (`useDraftManager.ts:233–239`). `setDrafts({})` on branch change (`useDraftManager.ts:95`) wipes **all** drafts regardless. A user who edits entry A, navigates to entry B without saving, then changes branches receives no confirmation prompt — entry A's work is silently destroyed and erased from localStorage.

**Fix:** Expose an `isAnyDirty()` helper from `useDraftManager` that compares `JSON.stringify(drafts[id])` vs `JSON.stringify(loadedValues[id])` for all IDs. Replace the `isSelectedDirty()` call in `confirmIfDirty` with `isAnyDirty()`. Note: this also requires fixing CRIT-5 first, since `modifiedCount` can't be used as a proxy.

---

### CRIT-5 — `modifiedCount` overcounts; cannot be used for dirty gating

**File:** `packages/canopycms/src/editor/hooks/useDraftManager.ts:78`

`modifiedCount = Object.keys(drafts).length`. Because `Editor.tsx` seeds a draft entry equal to the loaded value on first load, every visited entry is counted — whether or not the user touched it. The header counter is misleading and this field cannot be used as an `isAnyDirty` check without fixing the counting logic.

**Fix:** Derive `modifiedCount` by comparing each draft to `loadedValues[id]` rather than counting draft keys.

---

### HIGH-1 — Path-level permission bypass via `resolve-references` and `reference-options`

**Files:** `packages/canopycms/src/api/resolve-references.ts:57`, `packages/canopycms/src/api/reference-options.ts`

Both endpoints check branch access (`branchAccessWithSchema` guard) but never call `checkContentAccess()`. A user with branch access but path-restricted permissions can call `POST /:branch/resolve-references` with the IDs of restricted entries and receive their full content. Similarly, `reference-options` returns label/collection/id of candidates without checking per-path read permissions. `api/content.ts`, `api/entries.ts`, and `api/schema.ts` all call `checkContentAccess()` consistently; this is a localized gap.

**Fix:** In `resolveReferencesHandler`, after resolving each ID to a path, call `ctx.services.checkContentAccess(branchContext, branchRoot, relativePath, req.user, 'read')` and skip entries where access is denied. Apply the same filter in `loadReferenceOptions`.

---

### HIGH-2 — Missing `'use client'` on four exported editor components

**Files:**

- `packages/canopycms/src/editor/fields/ReferenceField.tsx:1` (uses `useEffect`, `useId`, `useState`)
- `packages/canopycms/src/editor/fields/MarkdownField.tsx:1` (uses `useRef`, `useCallback`, `useEffect`, `useId`)
- `packages/canopycms/src/editor/fields/BlockField.tsx:1` (uses `useMemo`, `useState`)
- `packages/canopycms/src/editor/fields/entry-link/InsertEntryLink.tsx:10` (uses `useState`, `useMemo`)

All four are transitively exported from `src/client.ts`. In Next.js App Router, importing a hook-using component without `'use client'` from a server component causes a runtime error. This will break any adopter using App Router.

**Fix:** Add `'use client'` as the first line of each file.

---

### HIGH-3 — `checkoutBranch` silently resets existing local branches with `checkout -B`

**File:** `packages/canopycms/src/git-manager.ts:494–518`

The fetch is wrapped in a silent `try/catch`. If fetch fails, code falls through to `checkout(['-B', branch, this.baseBranch])` which **force-resets** `branch` to the local baseBranch ref. This can silently discard commits that exist only locally on an existing feature branch, or create a new branch based on a stale local ref. No distinction between "fetch failed" and "remote ref genuinely doesn't exist."

**Fix:** Distinguish cases: (1) branch exists locally → `checkout` only, never `-B`; (2) remote ref found → create tracking branch; (3) neither → create local-only branch. Don't swallow fetch failures silently; surface them to the caller.

---

### HIGH-4 — Merge/rebase conflicts leave workspace in permanently broken state

**File:** `packages/canopycms/src/git-manager.ts:520–535`

`git.merge()` and `git.rebase()` calls have no error handling. On conflict, `simple-git` throws and the repository is left with `.git/MERGE_HEAD` / `.git/REBASE_MERGE` present and `<<<<<<<` markers in files. There is no `git merge --abort` / `git rebase --abort` in any catch path. Subsequent git operations on the workspace fail in confusing ways.

**Fix:** Wrap each call in `try/catch`. On error: run the appropriate abort command, throw a typed `GitConflictError` with the conflicted file list from `status().conflicted`.

---

### HIGH-5 — Schema mutation endpoints bypass guard-provided branch context

**File:** `packages/canopycms/src/api/schema.ts:454–728`, `api/schema.ts:312–324`

`createCollection`, `updateCollection`, `deleteCollection`, `addEntryType`, `updateEntryType`, `removeEntryType` all declare `guards: ['admin']` which provides `_gc: Record<string, never>`. The handlers then call `getSchemaOps(ctx, params.branch)` which fetches the branch context directly via `ctx.getBranchContext()` — bypassing the guard system entirely. Branch-level ACL is not checked; an admin can mutate schema on any branch regardless of access restrictions.

**Fix:** Use `guards: ['admin', 'branch'] as const` (or `branchAccess` if schema-mutation should be access-checked). Have handlers use `gc.branchContext` instead of calling `getSchemaOps`. Remove or limit `getSchemaOps` to the read-only `getCollectionHandler`.

---

### HIGH-6 — Preview bridge message handlers do not validate `event.source`

**Files:** `packages/canopycms/src/editor/preview-bridge.tsx:72–89, 117–125, 133–151`, `packages/canopycms/src/editor/hooks/useCommentSystem.ts:227–264`

`usePreviewData`, `usePreviewHighlight`, `usePreviewFocusEmitter`, and the focus-listener in `useCommentSystem` accept any `message` event matching the channel name shape — no `event.source` or `event.origin` check. Any other iframe or script on the page can inject `canopycms:draft:update` with arbitrary JSON and overwrite draft state, or inject focus events to hijack the editor. The `handleReady` handler does check `event.source !== iframeRef.current.contentWindow` (correct), but the others don't.

**Fix:** In iframe-side handlers, check `event.source === window.parent`. In editor-side listeners, track the preview iframe ref and check `event.source === previewFrame.contentWindow`.

---

### HIGH-7 — `dequeueTask` returns `null` on stale duplicates, halting the processing loop

**File:** `packages/canopycms/src/task-queue/task-queue.ts:130–134`

When the oldest pending task is a stale duplicate (already in `completed/` or `failed/`), the function deletes the file and `return null`. The caller's `while (dequeueTask(...) !== null)` loop in `processTaskQueue` stops immediately. Valid pending tasks are deferred to the next 5-second poll cycle. If several duplicates accumulate, each cycle only drains one.

**Fix:** After the dedup `unlink`, loop back to try the next task instead of returning `null`. Convert the sorted-list logic into a loop over `tasks[]` with `continue` instead of `return null`.

---

### HIGH-8 — `workerRunOnce` silently marks all prod tasks as skipped

**File:** `packages/canopycms/src/cli/init.ts:319–326`

In prod mode (`mode === 'prod'` with Clerk auth), `workerRunOnce` dequeues every task and marks it `completed: { skipped: true }`. Push-branch and create-PR tasks are permanently discarded with only a `console.warn`. The command exits 0. An operator running this to drain a backlog silently loses all queued work with no indication.

**Fix:** When `mode === 'prod'` and GitHub credentials are present, either execute the tasks via `CmsWorker` logic or exit nonzero with a clear "use the full worker daemon" message. Only skip-with-warning in dev mode.

---

### HIGH-9 — `useReferenceResolution` returns `null` for pending references, breaking preview

**File:** `packages/canopycms/src/editor/hooks/useReferenceResolution.ts:98–111`

When an ID is not yet in `resolvedCache`, the hook substitutes `null` into `resolvedValue`. Preview components that access `reference.name` (or any property) on that `null` throw/crash until the 300ms-debounced fetch completes. The effect re-triggers on every unrelated keystroke, so the broken state can persist continuously.

**Fix:** Fall back to the previously-resolved value for this ID if one exists; or keep the raw ID string so the preview can render a "loading" placeholder.

---

### HIGH-10 — `ReferenceField` useEffect refetches constantly; no cancellation for stale responses

**File:** `packages/canopycms/src/editor/fields/ReferenceField.tsx:73–101`

The effect lists `collections` and `entryTypes` as deps, which are arrays that may be recreated as fresh literals on every render. This can cause the reference-options API to be called on every keystroke in an unrelated field. Worse, there is no cancellation: if a dependency changes mid-fetch, the old promise still calls `setOptions` and can overwrite a newer fetch's result.

**Fix:** Use a stable `fetchKey` string as the sole dep (already computed in the component). Add an `ignore` flag or `AbortController` so stale responses are discarded. Example: `let active = true; ... .then(() => { if (active) setOptions(...) }); return () => { active = false }`.

---

### HIGH-11 — `BranchMetadataFileManager.write` — new-file path is not atomic

**File:** `packages/canopycms/src/branch-metadata.ts:123–134`

The existing-file path correctly uses temp-file + rename. The new-file path uses `writeFile(path, content, { flag: 'wx' })` which is **not** atomic: a crash mid-write leaves a zero-byte or partial `branch.json`. A subsequent `loadOnly` calls `JSON.parse` on the partial content and throws, making the branch permanently unreachable.

**Fix:** Use the same temp-file + rename pattern for initial creation (`wx` on the temp file, then `rename` to the real path).

---

## Medium Findings

### Content Store & Git

- **`ContentStore.delete` not atomic with index mutation** (`content-store.ts:556–571`): `fs.unlink` then `idIndex.remove()` — crash between them leaves a stale index entry whose `read()` throws ENOENT instead of NOT_FOUND.
- **`renameEntry` race with concurrent create of same slug** (`content-store.ts:583–669`): `readdir` check then `fs.rename` — on Linux, `rename` overwrites silently. Use `link` + `unlink` or hold a per-collection lock.
- **`BranchRegistry.regenerate` can miss a concurrent `invalidate()`** (`branch-registry.ts:89–114`): A second `invalidate()` during regeneration wipes the stale-flag signal; the freshly written registry is stale again. Add a generation counter.
- **`LocalAssetStore.upload` uses non-atomic `writeFile`** (`asset-store.ts:79–91`): Binary assets can be truncated on crash. Use `atomicWriteFile`.
- **`GitManager.ensureGitExclude` write is not atomic** (`git-manager.ts:672`): Crash mid-write truncates `.git/info/exclude`, possibly causing `.canopy-meta/` to be committed on next push.
- **No cleanup of abandoned workspace on init failure** (`git-manager.ts:406–481`): Partial clone left behind on network error. On next attempt, `rev-parse --git-dir` succeeds on the broken clone, skipping re-clone. Fix: `fs.rm(workspacePath, ...)` on clone failure.
- **Branch workspace leak — no delete/cleanup path** (`branch-workspace.ts`): `BranchWorkspaceManager` has no `deleteBranch`. Every merged branch clone accumulates on EFS indefinitely. Add a GC job.
- **`ensureLocalSimulatedRemote` uses `Date.now()` for temp branch names** (`git-manager.ts:207, 214`): Two calls in the same millisecond collide. Use `randomUUID()`.

### API Layer

- **`listBranchesHandler`/`createBranchHandler` have no guard declarations** (`api/branch.ts:404–439`): Access control is buried in handler bodies, invisible from route declarations. Add guard or document why this deviates.
- **`deleteBranch`/`updateBranchAccess` fetch branch context manually instead of using guards** (`api/branch.ts:445–482`): Pattern drift from the established guard system.
- **`updatePermissionsHandler` returns `{ok: true}` without `data` field** (`api/permissions.ts:94–98`): Declared response type includes permissions data; actual response body has none.
- **`updateInternalGroupsHandler` missing `data: {}`** (`api/groups.ts:143–148`): Response type is `ApiResponse<Record<string, never>>` which requires `data: {}`.
- **`addCommentHandler` returns `status: 200` for a create operation** (`api/comments.ts:107`): Should be `201 Created`.
- **`reference-options` inline query-param validation bypasses declared params** (`api/reference-options.ts:38–55`): Query schema validated inline via `req.query` instead of `params` on `defineEndpoint`; query params are invisible to the generated client.
- **`requestChangesHandler` body is declared but never read** (`api/branch-review.ts:27–28`): The `comment` field in the body is silently dropped.

### Schema / Validation

- **`traverseFields` silently skips list-mode object fields** (`validation/field-traversal.ts:90–101`): `!Array.isArray(value)` guard causes the entire field to be skipped. References inside list-of-objects are never validated.
- **`CanopyConfigSchema` includes `schema` field that `CanopyConfig` TS type does not** (`config/schemas/config.ts:42`): Zod/TS drift; the field is validated then silently lost from the type.
- **`composeCanopyConfig` double-applies `gitBotAuthorName`/`gitBotAuthorEmail`** (`config/helpers.ts:157–158`): Required fields set in the base object AND then conditionally spread again; the conditional spread is dead code.
- **`collectionMetaSchema` / `entryTypeMetaSchema` strip `description` field** (`schema/meta-loader.ts:42–51`): TS types allow `description`; Zod schemas don't, so `.collection.json` descriptions disappear silently.
- **`ReferenceValidator` has no cross-branch awareness** (`validation/reference-validator.ts:77`): References to entries on other branches produce false-positive "not found" errors.
- **`DeletionChecker.findIdInData` has orphaned `array` field type branch** (`validation/deletion-checker.ts:171–191`): `'array'` is not a member of `FieldType`; this is dead code that could mask real bugs.

### Editor

- **Block add/reorder during async save not disabled** (`editor/fields/BlockField.tsx:95–153`): `itemKeys` is mutated both in render and explicit handlers; drag during in-flight save can compute wrong indices.
- **`loadEntry` has no request cancellation** (`editor/Editor.tsx:347–372`): Fast entry-switch can clear the loading spinner while a newer entry is still loading.
- **`useReferenceResolution` async effect has no cancellation** (`editor/hooks/useReferenceResolution.ts:155–217`): Debounced fetch can call `setResolutionTrigger` after unmount or overwrite a newer fetch's cache result.
- **`useEditorLayout` ResizeObserver uses empty deps** (`editor/hooks/useEditorLayout.ts:43–57`): Won't reattach if header node mounts conditionally.
- **`useEntryManager` load effect deps include `drafts`** (`editor/Editor.tsx:347–372`): Effect re-runs on every keystroke via draft updates; wastes CPU.

### Operating Modes

- **`currentOperation` tracking overwritten by concurrent loops** (`worker/cms-worker.ts:260–276`): `stop()` only awaits last-set operation. See COMPOUND-3.
- **`ensureRemoteGit` has no error handling on first boot** (`worker/cms-worker.ts:282–295`): Clone failure exits worker with no diagnostic.
- **`workerRunOnce` mode detection via fragile regex on config file** (`cli/init.ts:278–285`): Use `jiti` (already used in `generate-ai-content.ts`) to actually import the config.
- **`sync` hardcodes `.canopy-dev/content-branches`** (`cli/sync.ts:199, 302, 424`): Won't work if used against a prod workspace.

---

## Low Findings

**Content Store:** `ContentIdIndex` collision throws for entire index on one bad file; `BranchRegistry.scanBranchDirectories` does sequential reads (use `Promise.all`); `GitHubService.getPullRequestNodeId` does an extra API round-trip per PR conversion.

**API Layer:** `listAssets` has no guard — any authenticated user can enumerate all asset keys (`api/assets.ts:102–111`); `deleteAsset` uses query param `key` instead of path param, making the key invisible to route-level validation; `resolve-references` swallows per-ID errors silently (callers can't distinguish "not found" from "error"); `branchParamSchema` is defined identically in 4 files instead of being imported from `validators.ts`.

**Schema:** `relativePathSchema` path-traversal check uses `includes('..')` (substring) not segment-equality; `MediaConfig.publicBaseUrl` accepts any string in TS but Zod enforces a URL format.

**Editor:** `MarkdownField` injects the same `<style>` block once per field instance instead of once globally; `FormRenderer` doesn't wrap object fields in `FieldWrapper` (no comments on object fields); `BlockField` uses Unicode glyphs as button content (use `@tabler/icons-react`); `useBranchManager.loadBranches` effect re-runs on every `branchName` change with a misleading comment; `handleJumpToField` uses a hard-coded 300ms delay as a timing workaround.

**Operating Modes:** `isPidAlive` on EFS lock returns false-negative across EC2 instances (use instance ID in lock); `DevClientSafeStrategy.shouldPush()` vs `supportsPullRequests()` asymmetry is confusing (add comment); `init` next-steps print `npm install` instead of detecting the package manager.

**Client/Server Boundary:** Missing `'use client'` on `EntryLinkContext.tsx`, `FormRenderer.tsx`, `useBranchManager.tsx`, `useUserContext.tsx` (hooks consumed only by `'use client'` files, so no runtime failure, but inconsistent).

---

## Architectural Observations

1. **No optimistic-concurrency control on content saves.** The codebase has a well-designed OCC pattern in `BranchMetadataFileManager` (version tokens, conflict detection) but `ContentStore.write()` has no analogous protection. The multi-editor EFS deployment is a stated goal; this gap should be addressed before prod launch.

2. **ContentIdIndex is a process-local snapshot, not a live index.** In a multi-process prod deployment, index divergence is expected and not recoverable without process restart. Either index must become a shared, filesystem-derived truth (re-scan on miss), or the architecture must guarantee single-writer-per-branch (which the current locking design does not).

3. **Guard system is solid but inconsistently applied.** The declarative guard system (`api/guards.ts`) is clean and well-designed. However, a significant fraction of handlers bypass it in favor of inline permission checks. This creates invisible access control that future contributors won't notice. Enforce the convention via a lint rule or document the allowed deviations explicitly.

4. **Git conflict handling has no user-visible surface.** Merge/rebase conflicts are a first-class concern for a branch-first CMS, yet the entire stack (git operation → worker → API → editor) has no typed error for conflicts, no UI to surface them, and no automatic abort/cleanup. This needs a design before prod use.

5. **Test coverage concentrates on happy paths.** Large, security-adjacent modules (`schema/meta-loader.ts`, `validation/deletion-checker.ts`, `validation/entry-link-validator.ts`, `api/route-builder.ts`, `ai/generate.ts`) have no unit tests. The integration test suite is valuable but doesn't cover failure paths or edge cases in isolation.

---

## Positive Observations

- **Authentication is genuinely centralized.** `http/handler.ts` is the single entry point for `req.user` population; no handler can accidentally trust a client-supplied user ID. This is correct and was maintained consistently across all 43 API files.
- **No shell injection.** All git operations use `simple-git` with array arguments throughout. Branch names are sanitized via `paths/branch.ts` with a strict allowlist regex. No `execSync`/`exec` with string concatenation was found.
- **TypeScript is clean.** 0 type errors across 7 workspace packages. Real types throughout — only 2 instances of `as Unknown` or similar casts found in the entire codebase.
- **Atomic writes are used correctly in most places.** The `atomicWriteFile` utility (temp-file + rename) is used in content writes, and `BranchMetadataFileManager` has the most sophisticated OCC implementation. The failures identified are exceptions to a good baseline pattern.
- **The guard system design is excellent.** `defineEndpoint` with typed `guards` declarations, validated through the route builder, gives a single glanceable access-control declaration per route. When used, it works well. The problems are gaps in application, not design flaws.
- **Path validation is layered.** Branded `LogicalPath`/`PhysicalPath` types prevent accidental raw-string usage; `paths/validation.ts` provides Zod schemas; `paths/normalize-server.ts` uses `path.resolve` + prefix-compare. Multiple layers working together.
- **1830 tests passing, clean typecheck, near-clean lint.** For a vibecoded codebase this is a strong automated foundation.

---

## Hygiene Notes

- **Dead code:** `packages/canopycms/src/settings-branch-utils.ts` exports `isSettingsBranch` and `getSettingsBranchName` — neither is imported anywhere. Delete it.
- **Test gaps:** `schema/meta-loader.ts` (370 lines), `validation/deletion-checker.ts` (234 lines), `api/route-builder.ts` (289 lines), `ai/generate.ts` (448 lines), `validation/entry-link-validator.ts`, `authorization/permissions/loader.ts`, `authorization/groups/loader.ts` — all substantial modules with zero unit tests.
- **`getErrorMessage()` pattern under-used:** CLAUDE.md and DEVELOPING.md mandate use of `getErrorMessage()` / `isNodeError()` from `utils/error.ts`. However 45 inline `err instanceof Error ? err.message : '...'` patterns were found across 21 files. `worker/cms-worker.ts` alone has 9. Mechanical refactor recommended.
- **`pathe` dep effectively unused:** Used in only 4 files while `node:path` is used in 65. Drop it.
- **`react-split-pane` is unmaintained** (last published ~2019, no React 18 support declared). Replace with `react-resizable-panels` or `allotment`.
- **Two icon libraries:** `@tabler/icons-react` and `react-icons` both ship. Consolidate to Tabler (the Mantine default).

---

_Report generated by automated multi-agent review (Phases 1–3) + main-Claude triangulation and spot-check verification._
