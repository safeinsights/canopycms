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

### ~~`worker/cms-worker.ts` (2,949 lines)~~ — **DONE 2026-08-23**, all four clusters split

Landed as `refactor/cms-worker-clusters` into `int-202608-b`. `cms-worker.ts` is now the
lifecycle shell: fields, constructor, `start`/`stop`, the cross-host worker lock,
`scheduleLoop`, `remote.git` provisioning, two shared helpers, and one delegating method
per cluster entry point.

| Module | Lines | Contents |
| --- | --- | --- |
| `cms-worker.ts` | 2,949 → **826** | lifecycle + delegators, all prior exports intact |
| `rebase.ts` | 1,103 | the rebase loop |
| `git-sync.ts` | 715 | `syncGit` and below, minus the rebase loop |
| `task-runner.ts` | 624 | `processTaskQueue` and below |
| `history-rewrite.ts` | 290 | the [SYNC-H1] kernel all three clusters touch |
| `worker-context.ts` | 140 | the seam |

**Actual vs estimate.** The plan predicted `cms-worker.ts` at ~780 (actual 802) and
`~150 lines net growth, ~5%` across the package. Actual growth is **+749 lines (+25%)**,
3,698 against 2,949 — four times the estimate. The plumbing was predicted correctly; what
was not is that a `Pick<WorkerContext, ...>` alias and a module header per file, each
documenting *why* that cluster needs what it needs, is 60–90 lines a module rather than
the ~25 assumed. That is documentation this code did not previously have anywhere, so it
is worth the lines — but a future estimate for a split of this shape should assume ~20%
growth, not ~5%.

`rebaseActiveBranches` was **667 lines in one method**. Decomposed at full depth rather
than merely relocated:

| Function | Lines (code-only) |
| --- | --- |
| `runRebaseCycle` — the walk + summary fold | 64 (42) |
| `rebaseOneBranch` — per-branch, returns `BranchRebaseOutcome` | 435 (198) |
| `runRebaseRounds` — the `MAX_REBASE_ROUNDS` resolve loop | 117 |
| `carryForwardRewrittenHistory` — the [SYNC-H1] arming guard | 53 |
| `conflictFilesToContentIds` — pure, testable without a git repo | 46 |

`rebaseOneBranch` at 435 is still the largest thing in the package's worker code, and
deliberately so: what remains is one linear sequence of guarded steps against a single
clone under a single lock, with the reasoning written at each step. Splitting it further
separates a guard from its rationale.

**What the split cost, recorded because it is the reusable lesson.** The test suite is the
whole safety net (eight `cms-worker*.test.ts` files, 5,860 lines, all passing unmodified),
and it drives `CmsWorker` by reaching *through the instance* — replacing `buildGitHubUrl`,
`octokit`, `executeTask` and `pushBranchToGitHub` on it, setting `running` directly, and
subclassing to override two `protected` test hooks. Two of those four replacements were
missed when cataloguing that surface up front, and calling the module-level function
directly instead of routing through the context turned 8 tests red. The fix was to widen
`WorkerContext`, never to edit a test. **Anything doing this again should enumerate the
`worker as unknown as {...}` sites for ASSIGNMENT, not just for calls.**

`CmsWorkerConfig` was deliberately **not** split, despite being a 16-field flat bag mixing
credentials, three poll intervals, retry policy and lock TTL. It is public API —
re-exported by `canopycms-cdk/src/worker.ts`, constructed by `canopycms-cdk/worker/index.ts`
and by adopters — so restructuring it is a breaking change, not a refactor. The
per-module `Pick<WorkerContext, ...>` aliases deliver the same "one config for four loops"
clarity with no blast radius.

See [worker/AGENTS.md](../../packages/canopycms/src/worker/AGENTS.md) for the resulting
module map and the invariants.

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

### Sequencing note — **superseded 2026-08-23**

This section used to say the git-sync cluster goes "last, if at all", and that none of this
should start while production-readiness work is in flight, because a split forces
re-verification of recently-fixed bugs in the most-churned modules in the repo.

That reasoning assumed the refactor would collide with in-flight prod work. **JP's call
inverted it:** *"get this worker into better, more digestible shape, before we start
testing it in production."* The quiet window before prod testing is the window, not the
hazard — deferring only moves the same collision later, under more pressure. Under that
goal `rebaseActiveBranches` was the *most* important thing to make digestible, not the
thing to defer, and it was also the best-defended (1,910 lines of test across four files,
all driving it through one entry point).

The rest of this file's advice stands, and the same test-first reasoning applies: split
where the tests already carve a seam, and do it while the module is quiet.

## Files

- `src/api/schema.ts` — extract wire types/conversions to `src/api/schema-wire.ts`
- `src/content-store.ts` — deduplicate index logic, extract reference resolution
- `src/reference-resolver.ts` — existing file, add reference-in-data resolution
- ~~`src/worker/cms-worker.ts`~~ — **done 2026-08-23**, all four clusters split
- `src/git-manager.ts` — extract the statics to `git-workspace-provisioning.ts`
- `src/api/branch.ts` — extract `branch-service.ts`
