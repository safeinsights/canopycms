# [P3] `GitHubService` can only authenticate with a static token, so a GitHub-App-only adopter has no path through it

Split out 2026-09-12 while planning adopter requests #45/#46 (GitHub App auth for the
worker). Deliberately scoped **out** of that work, and filed rather than dropped.

## The gap

`createGitHubService` (`packages/canopycms/src/github-service.ts:432-465`) resolves its
credential from the environment and nowhere else:

```ts
const tokenEnvVar = config.githubTokenEnvVar ?? 'GITHUB_BOT_TOKEN'
const token = process.env[tokenEnvVar] ?? process.env.CANOPYCMS_GITHUB_TOKEN
if (!token) { canopyLogWarn(...); return null }
```

It then builds a second Octokit via `createCanopyOctokit({ auth: options.token })`
(`:223`). When the worker gains GitHub App support, **this path does not**, so an adopter
who has only App credentials gets `githubService === null`.

## Why it is NOT a blocker for #45, measured rather than assumed

On the shipped AWS deployment this path is already inert:

- `supportsPullRequests()` is `true` in prod (`operating-mode/client-safe-strategy.ts:32`)
  and `false` in dev (`:74`) — so the naive reading is that it is live in prod. It is not.
- `CanopyCmsService` stamps **no** GitHub token onto the Lambda. Its environment
  (`packages/canopycms-cdk/src/constructs/cms-service.ts:737-762`) carries only the
  workspace root, the auth-cache path, `...props.environment`, the deployment name and
  `CANOPY_MODE` — by design, per the Security Model at `docs/deploying-to-aws.md:597-646`.
- So `createGitHubService` warns, returns `null`, `services.ts:365-378` leaves
  `githubService` undefined, and `commitToSettingsBranch` takes the "queue task for worker"
  branch at `services.ts:484`. Every PR on AWS is created by the worker
  (`worker/task-runner.ts:362`).

## Who it actually bites

A non-AWS, internet-having, App-only adopter running **no worker**. Their settings PRs sit
at `syncStatus: 'pending-sync'` indefinitely, with only a `canopyLogWarn` as signal.

**This is pre-existing, not opened by #45** — the identical thing happens today to any
adopter who configures no PAT. What #45 changes is only that "configure a PAT" stops being
the obviously-correct answer for an org that mandates Apps.

## If it is picked up

The change is small and local, and touches nothing in the worker:

- `createCanopyOctokit`'s `options` (`github-service.ts:39`) widens — it will already accept
  a structurally-typed `{ authStrategy, auth }` passthrough after #45.
- `GitHubServiceOptions` (`:61`) gains an App variant.
- `createGitHubService` reads `CANOPYCMS_GITHUB_APP_*` env vars.
- `GitHubService` never touches git, so `buildGitHubUrl` is not involved at all.

**One constraint that must survive:** do not add a top-level
`import { createAppAuth } from '@octokit/auth-app'` to `github-service.ts`. That module is
reachable from `services.ts:39`, i.e. it is in every adopter's Next.js **server** bundle.
`pnpm lint:bundle` checks the *client* boundary only and would not catch it — the placement
decision has to be made by hand. See the dependency-placement note in the #45 plan.
