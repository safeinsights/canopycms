---
priority: P3
adopters: NEITHER
summary: >-
  New 2026-09-12, split out while planning adopter requests #45/#46 and deliberately scoped OUT of them. `createGitHubService` resolves its credential from an env var and nothing else (`github-service.ts:494-495`), so when the worker gains GitHub App auth this second Octokit path does not, and an App-only adopter gets `githubService === null`. **Measured, not assumed, as a non-blocker:** `supportsPullRequests()` is true in prod, but `CanopyCmsService` stamps no GitHub token onto the Lambda at all (`cms-service.ts:1266-1291`), so the path is already inert on the shipped deployment and every PR is created by the worker. It bites only a non-AWS, internet-having, App-only adopter running no worker, whose settings pushes sit queued with a `canopyLogWarn` as the sole signal — and that is **pre-existing**, identical today for any adopter with no PAT. Carries one constraint for whoever fixes it: `github-service.ts` is in every adopter's Next.js SERVER bundle via `services.ts:39`, and `lint:bundle` only guards the CLIENT boundary, so `@octokit/auth-app` must not be imported there
---
# [P3] `GitHubService` can only authenticate with a static token, so a GitHub-App-only adopter has no path through it

Split out 2026-09-12 while planning adopter requests #45/#46 (GitHub App auth for the
worker). Deliberately scoped **out** of that work, and filed rather than dropped.

## The gap

`createGitHubService` (`packages/canopycms/src/github-service.ts:483-521`) resolves its
credential from the environment and nowhere else:

```ts
const tokenEnvVar = config.githubTokenEnvVar ?? 'GITHUB_BOT_TOKEN'
const token = process.env[tokenEnvVar] ?? process.env.CANOPYCMS_GITHUB_TOKEN
if (!token) { canopyLogWarn(...); return null }
```

It then builds a second Octokit via `createCanopyOctokit({ auth: options.token })`
(`:274`). When the worker gains GitHub App support, **this path does not**, so an adopter
who has only App credentials gets `githubService === null`.

## Why it is NOT a blocker for #45, measured rather than assumed

On the shipped AWS deployment this path is already inert:

- `supportsPullRequests()` is `true` in prod (`operating-mode/client-safe-strategy.ts:32`)
  and `false` in dev (`:74`) — so the naive reading is that it is live in prod. It is not.
- `CanopyCmsService` stamps **no** GitHub token onto the Lambda. Its environment
  (`packages/canopycms-cdk/src/constructs/cms-service.ts:1266-1291`) carries only the
  workspace root, the auth-cache path, `...props.environment`, the deployment name and
  `CANOPY_MODE` — by design, per the Security Model at `docs/deploying-to-aws.md:991-1039`.
- So `createGitHubService` warns, returns `null`, `services.ts:366-380` leaves
  `githubService` undefined, and `commitToSettingsBranch` takes the "queue task for worker"
  branch at `services.ts:485`. Every PR on AWS is created by the worker
  (`worker/task-runner.ts:360`).

## Who it actually bites

A non-AWS, internet-having, App-only adopter running **no worker**. Their settings push tasks sit
at `syncStatus: 'pending-sync'` indefinitely, with only a `canopyLogWarn` as signal.

**This is pre-existing, not opened by #45** — the identical thing happens today to any
adopter who configures no PAT. What #45 changes is only that "configure a PAT" stops being
the obviously-correct answer for an org that mandates Apps.

## If it is picked up

The change is small and local, and touches nothing in the worker:

- `createCanopyOctokit`'s `options` (`github-service.ts:79`) widens — it will already accept
  a structurally-typed `{ authStrategy, auth }` passthrough after #45.
- `GitHubServiceOptions` (`:112`) gains an App variant.
- `createGitHubService` reads `CANOPYCMS_GITHUB_APP_*` env vars.
- `GitHubService` never touches git, so `buildGitHubUrl` is not involved at all.

**One constraint that must survive:** do not add a top-level
`import { createAppAuth } from '@octokit/auth-app'` to `github-service.ts`. That module is
reachable from `services.ts:39`, i.e. it is in every adopter's Next.js **server** bundle.
`pnpm lint:bundle` checks the *client* boundary only and would not catch it — the placement
decision has to be made by hand. See the dependency-placement note in the #45 plan.
