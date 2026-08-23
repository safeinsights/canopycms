# `worker/` — Worker

The CmsWorker daemon, its task queue, and the git sync/rebase loop.

Split out of the root [AGENTS.md](../../../../AGENTS.md) on 2026-08-23, where this had grown to
287 words inside a single bullet. The **code comment at the point of the rule is
authoritative**; this file is the map to where those rules live.

## Overview

CmsWorker daemon, task queue, deployment infrastructure; `pushBranchToGitHub` classifies a non-fast-forward push rejection (two CanopyCMS deployments colliding on one branch name) and fails fast via `PermanentTaskError` instead of burning the retry budget, recording the reason as `syncFailureReason` on branch metadata (`updateBranchMetadataOnFailure`/cleared by `updateBranchMetadata` on the next success); `pushSettingsBranches` gives the same rejection a specific warning naming the collision; `ensureRemoteGit`'s `scrubPersistedRemote` guarantees the shared bare repo's config carries no `remote.origin.url` (a cloned-with-token URL persisted on EFS would let a compromised Lambda read the bot token) — fails CLOSED, treating an unreadable config read as "token might still be there" rather than "absent," and now re-runs on the already-exists fast path too, so a token that survived one interrupted scrub doesn't survive forever; `rebaseActiveBranches`'s interrupted-rebase recovery (this worker's own abandoned work from a crash/OOM/spot-interruption) logs, by path, every working-tree file the `rebase --abort` will discard — keyed on the git-status WORKING-TREE column only, since the replay's own staged files (`M `) are committed history and survive untouched while an editor's unstaged save (` M`) does not; its round-loop conflict resolution also handles MODIFY/DELETE conflicts (`UD`/`DU`, no "their version" to check out) via `git rm`/`git add` instead of `checkout --theirs`, since an escaping throw there used to skip both `rebase --abort` sites and wedge the clone forever

## `log.ts`

`workerLog`/`workerLogWarn`/`workerLogError`, which prefix every line with an ISO-8601 UTC timestamp and a level tag (stdout and stderr share one file on the prod instance, so severity is otherwise unrecoverable). INVARIANT: all worker code must log through these — the CloudWatch agent keys `multi_line_start_pattern` on that prefix, so an unprefixed line is folded into the PREVIOUS event instead of starting its own. Re-exported from `cms-worker.ts` for `canopycms-cdk/worker/index.ts` rather than adding a package entrypoint
