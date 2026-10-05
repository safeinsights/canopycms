# A permanently missing worker reads as "still starting"

## Priority: P3 [BOTH]

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
