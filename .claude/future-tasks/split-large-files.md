# Split Large Files

Extract focused modules from oversized files to improve maintainability.

## api/schema.ts (949+ lines)

Wire-format conversion functions (`toWireEntryType`, `toWireCollection`, `toWireFlatSchema`, `resolveSchemaRef`, and the `Wire*` type definitions) are a separate concern from endpoint handlers.

**Action**: Extract to `src/api/schema-wire.ts`:

- All `Wire*` type definitions (WireEntryType, WireCollectionConfig, WireFlatSchemaItem)
- `resolveSchemaRef()`, `toWireEntryType()`, `toWireCollection()`, `toWireFlatSchema()`
- The `Registry` type alias

## content-store.ts (~~793~~ ~~1734~~ **2177 lines** as of 2026-08-23 — nearly tripled since filing)

1. ~~**Duplicated index-update logic** in the `write()` method (two nearly identical blocks for updating the content ID index)~~ — **STALE, verified 2026-08-13.** Only **one** `liveIndex.add(...)`/`updatePath(...)` block remains in `write()` (~`:1091-1099`); the duplication was consolidated by other content-store work since this was filed. Note also that `resolveReferencesInData` is still a private instance method (~`:1594-1670`), but `reference-resolver.ts` (175 lines) is **not** the move target — it serves a different concern (ID→display-value resolution for the reference-field UI, not read-time data resolution).
2. **`resolveReferencesInData`** private method (lines 693-758) could be extracted to `reference-resolver.ts`

**Action**:

- Extract a shared `updateContentIdIndex()` helper within content-store.ts
- Move `resolveReferencesInData` to `src/reference-resolver.ts` (which already exists and handles reference resolution)

## Whole-package assessment, 2026-08-23

Added by the [baseline structural evaluation](../../docs/reviews/2026-08-structure.md),
which measured every large module rather than only the two above. Verdicts differ
per file, and two of them are **do not split**.

### `worker/cms-worker.ts` (2,949 lines) — genuinely tangled, and the seam is proven

Four **disjoint** call trees under the single entry `start()`, sharing only six
helper methods (`buildGitHubUrl`, `readPublishedSha`, `branchWorkspacePath`,
`ensureStatusReport`, `enqueueGitHubPush`, `forcePublishToLocalRemote`):

| Cluster | Root | Reachable only from it |
| --- | --- | --- |
| Lifecycle / cross-host lock | `start`/`stop` | `acquireLock`, `releaseLock`, `scheduleLoop`, `ensureRemoteGit`, `verifyBaseBranchExists`, `ensureSettingsBranch` |
| Task queue | `processTaskQueue` | `executeTaskWithTimeout`, `executeTask`, `pushBranchToGitHub`, `updateBranchMetadata(OnFailure)`, … |
| Git sync / rebase | `syncGit` | `rebaseActiveBranches`, `reconcileTrackedBranches`, `refreshBaseBranchWorkspace`, `pushSettingsBranches`, `pollMergeState`, … |
| Auth cache | `refreshAuthCache` | *(nothing — one isolated method)* |

`rebaseActiveBranches` is **667 lines in one method**. `CmsWorkerConfig` is a
16-field flat bag mixing GitHub credentials, three independent poll intervals,
task-retry policy and lock TTL — one config for four loops.

**The decisive evidence that the seam is real:** the test suite has *already* been
carved along exactly these lines — `cms-worker-base-refresh`, `-content-lock`,
`-merge-poll`, `-rebase-publish`, `-rebase-wedge`, `-rebase`, `-sync-reconcile`,
plus a 1,927-line `cms-worker.test.ts`. **Seven files were split out of the test for
a production file that was never split.**

**Order:** extract the auth-cache cluster first (one isolated method), then the task
queue into `worker/task-runner.ts`, leaving `CmsWorker` as the lifecycle shell. The
git-sync cluster is the genuinely hard one and should go last, if at all.

### `git-manager.ts` (1,467 lines) — two modules sharing a class name

Everything from `cloneRepo` down to `initializeWorkspace` is `static` — workspace
**provisioning**, sharing no instance state; the class is acting as a namespace.
Everything from `status()` onward is per-repo **instance** operations needing
`repoPath`/`baseBranch`/`remote`. `status()` is the dividing line, and a module
header added 2026-08-23 says so in the file.

Clean **medium** extraction into `git-workspace-provisioning.ts`. Lower risk than
the worker split and higher value than the two originally filed above.

### `api/branch.ts` (965 lines) — a branch service wearing route-handler clothes

**7 of its 14 exports have exactly one consumer: `api/branch.test.ts`.** It is the
**only one of 19 endpoint modules** that exports its handlers, and it exports them
*because* the test imports them. It also does raw infrastructure work rather than
delegating — `GitManager.bareRemoteHasBranch`, `GitManager.deleteBareRemoteHead`,
`fs.rm(branchContext.branchRoot)` — where `api/content.ts` delegates to
`content-store` and `api/schema.ts` to `schema-store`.

There is no `BranchService`, so branch-lifecycle rules can only be reused or tested
through HTTP shapes, and the exported surface is a standing invitation for a second
caller to bind to a route internal.

**Action:** extract `branch-service.ts` (the three policy predicates
`canCreateBranch`/`canDeleteBranch`/`canModifyBranchAccess`, plus the four
operations) beside the existing `branch-*` modules. `api/branch.ts` shrinks to
guards + `defineEndpoint` blocks like its 18 siblings, and the test imports the
service.

### Do NOT split

- **`schema/schema-store.ts` (1,208 lines).** Large but disciplined: every public op
  is `foo()` → `withSchemaLock` → `fooInner()`, 28 methods, largest 145 lines. This
  is what controlled size looks like. Leave it.
- **`editor/Editor.tsx` (1,512 lines).** Already a composition root — 12 hooks
  extracted into 17 well-tested files. What remains is 26 `useState` calls, a
  24-prop interface and a ~490-line JSX return. Extracting an `<EditorBody>` would
  help marginally; the hard work is done and done well. Low priority.

### Sequencing note

All of the above touches files that the ranked production-readiness work also
touches (`content-store.ts`, `cms-worker.ts` and `git-manager.ts` are the three
most-churned files in the last 400 commits). **Do not start any of it while those
are in flight** — a split forces re-verification of recently-fixed bugs in exactly
the modules where the bugs were.

## Files

- `src/api/schema.ts` — extract wire types/conversions to `src/api/schema-wire.ts`
- `src/content-store.ts` — deduplicate index logic, extract reference resolution
- `src/reference-resolver.ts` — existing file, add reference-in-data resolution
- `src/worker/cms-worker.ts` — auth-cache and task-queue clusters first
- `src/git-manager.ts` — extract the statics to `git-workspace-provisioning.ts`
- `src/api/branch.ts` — extract `branch-service.ts`
