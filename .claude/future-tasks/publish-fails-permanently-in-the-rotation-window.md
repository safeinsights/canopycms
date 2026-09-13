# [P2] A publish inside the credential-rotation window fails permanently, though a working token is already available

Found by adversarial review round 1 on PR #334 (reactive secret re-read), 2026-09-13.
Deliberately **not** fixed there: the approved design for #334 has exactly one refresh
trigger, and closing this needs a second one inside `task-runner.ts` — a module that PR
explicitly left untouched. Filed with the analysis so it is not re-derived.

## The window

`CmsWorker.syncGitWithCredentialRefresh()` (`packages/canopycms/src/worker/cms-worker.ts`)
is the only site that calls `refreshCredential()`. It runs on the git-sync loop, default
`gitSyncInterval` 5 minutes.

A `push-*` task that meets a revoked PAT fails on a different clock:

1. `git push` rejects with a status-less error (exit 128), so `isPermanentTaskFailure`
   (`task-runner.ts:91-98`) returns false and the task is retried.
2. Retries run at 5s / 10s / 20s — `backoffMs = Math.min(5000 * 2 ** (retryCount - 1), 60_000)`
   at `src/task-queue/task-queue.ts:258`, with `DEFAULT_MAX_RETRIES = 3` at `:24`.
3. After roughly **35–50 seconds** (35s of backoff, plus up to one 5s task-poll interval
   before each pickup) the budget is spent: `failTask`, then
   `updateBranchMetadataOnFailure` marks the branch `sync-failed`.

So for about **4.5 of every 5 minutes** after a revocation, a publish fails permanently
even though Secrets Manager already holds the working token and the next sync tick would
have picked it up. The editor sees a failed publish and must resubmit.

**Not a regression.** Before #334 every publish after a revocation failed forever, so this
is strictly better — which is why it is P2 and not higher.

## Why it was not fixed in #334

A wrapper around `processTaskQueue` cannot see it: `processTasks` catches each task's error
internally and does not rethrow (`task-runner.ts:217-245`), so the outer caller observes
nothing. The fix therefore has to reach into that catch, which means:

- a new member on `TaskRunnerContext` (`worker-context.ts`) — and that file's INVARIANT is
  that instance-backed members stay **functions**, so it would be
  `refreshGitHubCredential(): Promise<void>`, matching `buildGitHubUrl()` and `octokit()`;
- a call in `processTasks`' catch, before the retry/fail decision;
- tests for both.

That is a modest change, but it widens the diff into two core modules on a LOW-severity,
non-regressing finding, which is the wrong trade inside a PR about secret handling.

## What to do

Add the call in `processTasks`' catch. The cost of the extra trigger site is near zero: the
provider's 5-minute floor and its unchanged-value guard mean a storm of failing tasks issues
at most one `GetSecretValue` per five minutes, and returns `undefined` (no swap) whenever
nothing rotated — see `packages/canopycms-cdk/worker/credential-refresh.ts`.

Gate it on nothing, for the same reason the sync wrapper does not: a git push rejected for a
dead token carries no HTTP status, so any classifier-based gate would never fire.

The test that matters is not "the provider was called" but that a task **which would
otherwise have exhausted its retries** now succeeds on a later attempt after a rotation —
otherwise the assertion passes with the fix doing nothing useful.

Related: [worker-app-env-var-check-untested.md](worker-app-env-var-check-untested.md),
[refresh-auth-cache-error-handling.md](refresh-auth-cache-error-handling.md).
