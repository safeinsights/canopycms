# `worker/` — Worker

The CmsWorker daemon, its task queue, and the git sync/rebase loop.

Split out of the root [AGENTS.md](../../../../AGENTS.md) on 2026-08-23, where this had grown to
287 words inside a single bullet. The **code comment at the point of the rule is
authoritative**; this file is the map to where those rules live.

## Module map

`cms-worker.ts` was 2,949 lines holding four **disjoint** call trees under one entry point
(`start()`). Split 2026-08-23; each cluster is now its own module, reached through a
`WorkerContext`.

| File                 | What it owns                                                                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cms-worker.ts`      | The `CmsWorker` class: fields, constructor, `start`/`stop`, the cross-host worker lock, `scheduleLoop`, `remote.git` provisioning, `buildGitHubUrl`/`branchWorkspacePath`, `refreshAuthCache`, and one delegating method per cluster entry point |
| `worker-context.ts`  | `WorkerContext` — the only channel between the class and the extracted clusters                                                                                                                                                                  |
| `task-runner.ts`     | The task-queue cluster: `processTaskQueue` and everything below it                                                                                                                                                                               |
| `git-sync.ts`        | The git-sync cluster: `syncGit` and everything below it except the rebase loop                                                                                                                                                                   |
| `rebase.ts`          | The rebase loop, the deepest leaf of the git-sync cluster                                                                                                                                                                                        |
| `history-rewrite.ts` | The [SYNC-H1] kernel all three clusters touch                                                                                                                                                                                                    |
| `log.ts`             | `workerLog`/`workerLogWarn`/`workerLogError`                                                                                                                                                                                                     |

Imports run one way only — `cms-worker` → {`task-runner`, `git-sync`} → `rebase` →
`history-rewrite` → `worker-context` — and `pnpm lint:cycles` enforces it.

## `worker-context.ts`

**INVARIANT: every instance-backed member is a FUNCTION, and `CmsWorker.ctx()` builds a
fresh context per call.** This is load-bearing, not style. The test suite drives
`CmsWorker` by reaching through the instance: two files REPLACE `buildGitHubUrl` on it (to
aim pushes at a local fixture repo rather than github.com), two ASSIGN a mock over
`octokit`, `cms-worker.test.ts` REPLACES `executeTask` and `pushBranchToGitHub`, several
set `running` directly, and `cms-worker-content-lock.test.ts` SUBCLASSES `CmsWorker` to
override the two rebase test hooks. A context that captured any of those at construction
hands the extracted code the pre-test value — which for `buildGitHubUrl` means a test's
push going to github.com for real.

The corollary bit twice already: **an extracted module must call `ctx.executeTask(...)` /
`ctx.pushBranchToGitHub(...)`, never the module-level function of the same name**, even
though both are defined in `task-runner.ts` beside their callers. Calling directly bypasses
the stub and turns 8 tests red.

## `task-runner.ts`

`pushBranchToGitHub` classifies a non-fast-forward push rejection (two CanopyCMS
deployments colliding on one branch name) and fails fast via `PermanentTaskError` instead
of burning the retry budget, recording the reason as `syncFailureReason` on branch metadata
(`updateBranchMetadataOnFailure`, cleared by `updateBranchMetadata` on the next success).
`PermanentTaskError`/`isPermanentTaskFailure` are re-exported from `cms-worker.ts`, which
is the package's advertised worker entrypoint.

## `git-sync.ts`

`pushSettingsBranches` gives a non-fast-forward rejection a specific warning naming the
collision, and pushes ONLY this deployment's own settings branch. `ensureRemoteGit`'s
`scrubPersistedRemote` (still in `cms-worker.ts`, since it is part of provisioning)
guarantees the shared bare repo's config carries no `remote.origin.url` — a
cloned-with-token URL persisted on EFS would let a compromised Lambda read the bot token.
It fails CLOSED, treating an unreadable config read as "token might still be there" rather
than "absent," and re-runs on the already-exists fast path too, so a token that survived
one interrupted scrub doesn't survive forever.

## `rebase.ts`

`runRebaseCycle` walks `content-branches/` and folds each branch's `BranchRebaseOutcome`
into the summary; `rebaseOneBranch` does the per-branch work and **never throws**.

The outcome type's `rebased` rider on `{ kind: 'failed' }` is not tidying-up: the original
loop pushed to `rebased[]` and only then ran the [SYNC-H1] carry-forward, which can still
throw. A branch can legitimately be in BOTH buckets — its history moved and publishing the
move failed — and collapsing that drops a real rebase from `worker-status.json`.

Interrupted-rebase recovery (this worker's own abandoned work from a crash/OOM/spot
interruption) logs, by path, every working-tree file the `rebase --abort` will discard —
keyed on the git-status WORKING-TREE column only, since the replay's own staged files
(`M `) are committed history and survive untouched while an editor's unstaged save (` M`)
does not.

`runRebaseRounds` handles MODIFY/DELETE conflicts (`UD`/`DU`, no "their version" to check
out) via `git rm`/`git add` instead of `checkout --theirs`. **INVARIANT: it never throws
and never aborts** — the caller owns the single `rebase --abort` and its `finally` owns the
last-resort one. An escaping throw from there used to skip both abort sites and wedge the
clone forever. It takes `isLockCompromised` as a callback, not a boolean, because
[SYNC-C1] the content-write lock can be lost BETWEEN rounds.

`pollMergeState` lives here rather than in `git-sync.ts` because the rebase loop is its
only caller: submitted/approved branches are skipped for rebasing but still need their PR
resolution polled, and this loop is the only thing that walks every branch workspace.

## `history-rewrite.ts`

**THE INVARIANT, since it is spread across three callers:** every force push leases on a
SPECIFIC commit this worker knows its own rebase replaced — the marker, or the pre-rebase
tip — never on "whatever `remote.git` holds right now". A lease on the current tip is
satisfied by a reviewer's direct push to the PR branch and would delete it, silently, from
`remote.git` and then from GitHub.

## `log.ts`

`workerLog`/`workerLogWarn`/`workerLogError`, which prefix every line with an ISO-8601 UTC
timestamp and a level tag (stdout and stderr share one file on the prod instance, so
severity is otherwise unrecoverable). INVARIANT: all worker code must log through these —
the CloudWatch agent keys `multi_line_start_pattern` on that prefix, so an unprefixed line
is folded into the PREVIOUS event instead of starting its own. Enforced by eslint
`no-restricted-syntax` on `**/worker/**`, so a new file in this directory inherits the ban.
Re-exported from `cms-worker.ts` for `canopycms-cdk/worker/index.ts` rather than adding a
package entrypoint — **that re-export must survive any future reshuffle.**
