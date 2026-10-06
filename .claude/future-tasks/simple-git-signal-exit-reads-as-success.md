# simple-git reads a git killed by a signal as success

## Priority: P2 [BOTH]

Measured 2026-10-06 while writing the SIGKILL test for crash-safe branch provisioning.

## The gap

simple-git's default error detection (`isTaskError` in its `error-detection.plugin`) fails a task
only when `exitCode && stdErr.length`. A git process killed by a signal closes with exit code
`null`, usually with no stderr, so the task resolves as if git succeeded. The provisioning test
killed only the git child of a clone: the clone "succeeded", the clone retry never ran, and the
next step failed with `not a git repository`.

`GitManager` now passes `errors: failOnSignalExit` (git-manager.ts) to every simple-git instance it
creates, including the clone's, so provisioning, settings and every `GitManager` operation treat a
signal exit as a failure. Every other `simpleGit(...)` in the package still has the default:

- the worker's own instances in `worker/cms-worker.ts`, `worker/git-sync.ts` (the GitHub fetch
  and push, the base-branch refresh's fetch and `merge --ff-only`), `worker/rebase.ts`,
  `worker/history-rewrite.ts`, `worker/remote-git-maintenance.ts` and `worker/task-runner.ts`;
- `sync-core.ts`, `utils/git.ts`, `cli/sync.ts`, `cli/project-detect.ts`,
  `api/admin-branch-health.ts`, and `GitManager.repoExistsAt`'s.

A worker git killed by the EC2 OOM killer mid-`rebase` or mid-`merge` would be read as done. The
interrupted-rebase recovery catches a stopped rebase on the next cycle, but a "successful" merge
or push that did not happen is recorded as success in worker-status.json.

## Suggested fix

One shared factory for simple-git instances that always sets `errors: failOnSignalExit` (and the
no-auto-gc config), used everywhere the package creates one; an eslint `no-restricted-imports`
rule on bare `simpleGit` outside that factory keeps it that way.
