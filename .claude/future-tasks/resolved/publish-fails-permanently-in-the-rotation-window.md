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
   (`task-runner.ts:92-99`) returns false and the task is retried.
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
internally and does not rethrow (`task-runner.ts:218-260`), so the outer caller observes
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

Related: [worker-app-env-var-check-untested.md](../worker-app-env-var-check-untested.md),
[refresh-auth-cache-error-handling.md](../refresh-auth-cache-error-handling.md).

## Resolution — 2026-09-13, branch `fix/task-failure-credential-refresh`, base `int-202609-a`

Fixed as filed, with one deviation and one addition, both from measuring rather than reading.

**As filed.** `WorkerContext.refreshGitHubCredential(): Promise<void>`, a function per the
INVARIANT, is routed by `CmsWorker.ctx()` to a new `CmsWorker.refreshGitHubCredential()` and
called ungated in `processTaskQueue`'s per-task catch. `syncGitWithCredentialRefresh` now calls
the same method, so the two trigger sites share one never-throwing implementation instead of
two copies of try/log/swallow.

**Deviation: after the outcome is recorded, not before.** The decision does not depend on the
refresh, which returns `void`. Calling it after `retryTask`/`failTask` means the task is already
in `pending/` or `failed/` while a network read runs. The loop is sequential, so the retry still
cannot run before the refresh settles.

**Addition: a bound.** A Secrets Manager read on the task loop is a new hazard, because the loop
awaits it and a read that never settled would stop every publish queued behind it. Measured: the
provider's `new SecretsManagerClient(...)` (probed with only a region added) resolves
`@smithy/node-http-handler@4.5.0` with an empty handler config in `legacy` defaults mode, and
that handler arms no connection, request or socket timer when none is configured. So
`refreshGitHubCredential` races the read against `taskTimeoutMs`. (Later commits gave that client
transport timeouts and a 20s per-attempt deadline, but one read can still take 87s, over the 60s
default `taskTimeoutMs`, so the race stays.)

**The test that matters**, per "What to do" above, is "saves a publish whose token rotated, which
would otherwise exhaust its retries" in `cms-worker-credential-refresh.test.ts`. It drives a
`push-branch` task through the real `processTaskQueue`, moving the clock past each backoff, with
a push stub that reads the credential through the real `buildGitHubUrl()`. Its paired control,
"still exhausts the budget when nothing rotated", proves the harness really reaches exhaustion.
Break-and-rerun, each restored by `cp` and checked with `cmp`:

| Mutation                         | Went red                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------- |
| delete the catch's call          | saves a publish; still exhausts; keeps the task's own error; never settles     |
| remove the `taskTimeoutMs` race  | never settles                                                                 |
| let the refresh rethrow          | the sync wrapper's "rethrows the SYNC error"; keeps the task's own error; never settles |
| call it on success too           | saves a publish (provider called twice); does NOT re-read when the task succeeds |

## What this does not close

The provider's 5-minute floor is shared by both triggers, and so is core's own 60s floor
(`refreshGitHubTokenMinIntervalMs`, added later). A rotation is picked up at the first failure
after it that the floors permit: immediately, unless some failure in the last five minutes has
already used the read. The two floors can also stack and push pickup further out — see
[core-floor-shifts-provider-floor-phase.md](../core-floor-shifts-provider-floor-phase.md).

- **Store, then revoke** (a planned rotation): normally closed. The first failure after
  revocation reads the new value, and the task's own retry uses it — unless an unrelated failure
  already used the read in the preceding floor window (the last bullet below), in which case the
  first failure after revocation can still be floor-blocked and that publish can still fail.
- **Revoke, then store**, or an expired token replaced late: failures before the new value is
  stored read the old one and stamp the floor, so a publish that exhausts its retries inside the
  next five minutes still fails.
- A read issued by an **unrelated** task failure (a GitHub outage, a diverged branch) in the five
  minutes before a rotation holds off the sync loop's read the same way. That could not happen
  before this change, since tasks did not read. Accepted: it needs an unrelated failure inside
  that window, and it costs at most one extra floor.

Closing the revoke-first case would need a shorter floor for the GitHub token specifically. By
`credential-refresh.ts`'s own arithmetic that is cheap, but it is a cost-versus-latency call
rather than a correctness fix, so it is left to JP. `docs/deploying-to-aws.md#rotating-a-secret`
now tells operators to store before revoking.

A task that `isPermanentTaskFailure` fails fast (a REST call rejected with a 4xx) is not retried,
so the refresh repairs the task after it, not that one.
