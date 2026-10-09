---
priority: P2
adopters: BOTH
summary: >-
  RESOLVED (2026-10-09). The prod not-ready 503 reads the worker's recorded startup failure: a failure from the latest attempt answers 503 `WORKER_FAILED` with no `Retry-After`, naming it with account ids masked; one a newer worker carried forward stays retriable. Auto-detecting `remote.git` treats only ENOENT as absent. A handler test drives real prod provisioning. A worker that was never deployed still reads as starting; the worker-down alarm covers it
---
# A permanently missing worker reads as "still starting"

## Priority: P2 [BOTH]

**Cluster, worker-down observability:** this file,
[worker-secret-errors-before-start-are-invisible.md](worker-secret-errors-before-start-are-invisible.md),
[worker-boot-loop-alarming.md](worker-boot-loop-alarming.md) and
[worker-app-env-var-check-untested.md](worker-app-env-var-check-untested.md) are four views of "the
worker failed and nobody can tell why". Fix them together: the 503 is constant, secret reads happen in
`main()` before `start()` so `lastFatalError` is never written for them, and no CDK alarm exists.

## The gap

In prod, the Lambda answers 503 "CMS worker not ready" (`http/worker-not-ready.ts`) whenever
`GitManager.initializeWorkspace` finds no `{workspaceRoot}/remote.git` (`RemoteNotReadyError`,
`git-manager.ts`). That is right for the minutes before the EC2 worker's first boot. The same
answer comes back, forever, when:

- the worker failed at startup (bad GitHub App credentials, an empty repo) and recorded
  `lastFatalError` in `worker-status.json`;
- the worker was never deployed;
- `stat(remote.git)` fails for another reason (EACCES, or `remote.git` is a file) — the
  auto-detection in `resolveRemoteUrl` treats every stat error as "absent".

The message says to retry and to ask an admin if it persists, but nothing tells the admin why,
and `/admin` (where `lastFatalError` is shown) is behind the same 503 on a fresh deployment.

## Suggested shape

In `workerNotReadyResponse` or the handler's provisioning catch, read `{taskDir}/worker-status.json`
tolerantly (as `api/admin.ts readWorkerStatus` does). When `lastFatalError.phase === 'startup'`,
answer with its already-redacted message and no `Retry-After`. Have `resolveRemoteUrl` treat only
ENOENT as "absent" and surface other stat errors.

## Also

Every handler test feeds `RemoteNotReadyError` in through mocks; only the AI route's test drives
real prod provisioning. A handler test using the real `getBranchContext` with prod mode, a temp
`CANOPYCMS_WORKSPACE_ROOT` and no `remote.git` would catch a later change that wraps the error.
