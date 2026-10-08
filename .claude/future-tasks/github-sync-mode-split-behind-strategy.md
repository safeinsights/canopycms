# Each `sync*` function in `api/github-sync.ts` repeats the githubService-vs-queue split

## Priority: P3

Raised 2026-10-07, while adding `syncDeleteRemoteBranch`. Out of scope for that change.

## Problem

`syncSubmitPr`, `syncConvertToDraft` and `syncDeleteRemoteBranch` each decide the same thing by
hand: call `ctx.services.githubService` when one exists (dev, or a server with internet), else
enqueue a worker task when `clientOperatingStrategy(mode).supportsPullRequests()` (prod's Lambda
has no internet). Each copy also decides for itself what a failure becomes: `syncSubmitPr` returns
a `syncStatus`, `syncConvertToDraft` logs and returns nothing, `syncDeleteRemoteBranch` returns a
client-facing warning. A fourth GitHub action would copy the split a fourth time.

## Question to settle

Should "how does this deployment reach GitHub" move behind the operating-mode strategy
(`operating-mode/`), so each `sync*` function states only the action and its payload, and the
strategy picks direct call or queue? Things to weigh:

- whether `githubService` presence or the mode is the right discriminator: `createGitHubService`
  (`github-service.ts`) returns null when the mode has no PRs, so they differ only when a
  PR mode lacks a token or remote URL and the queue is used even with internet;
- that the direct path and the worker path run different code for the same action
  (`GitHubService` methods vs `worker/task-runner.ts`'s `executeTask` cases), so "already gone"
  style outcomes are handled twice;
- whether failures should come back in one shape.
