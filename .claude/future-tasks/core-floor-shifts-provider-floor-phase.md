# [P3] On AWS, core's 60s refresh floor stacks on the provider's 5-minute floor and can double rotation pickup

Found 2026-09-13 by the claims pass over the worker-credential epic, from a probe run by the
docs claim-check.

## What happens

- Core's floor (`refreshGitHubTokenMinIntervalMs`, default 60s) is stamped BEFORE the provider is
  called. `resolveWorkerGitHubAuth` → `refreshCredential` in
  `packages/canopycms/src/worker/github-auth.ts` does that stamping.
- It is stamped even when the provider then returns `undefined` because its own 5-minute floor
  throttled the call. That floor is `createReactiveSecret` in
  `packages/canopycms-cdk/worker/credential-refresh.ts`.
- On AWS the two floors are therefore independent clocks, and a call one floor throttles can still
  push the other one out.

## Measured

The probe ran the real `createReactiveSecret` and the real core floor, wired as
`packages/canopycms-cdk/worker/index.ts` wires them:

| t | Event | Result |
| --- | --- | --- |
| 0s | a git sync fails | reads the old value |
| 270s | an unrelated task fails | throttled by the provider, but stamps core's floor |
| 280s | the new token is stored | — |
| 300s | the git sync fails | throttled by core's floor; no read |
| 600s | next git sync | the rotated token finally arrives |

Worst-case pickup is about 10 minutes, where it was about 5 before the core floor.
`docs/deploying-to-aws.md#rotating-a-secret` now states the measured worst case.

## Fix (one line, plus a test)

Pass `refreshGitHubTokenMinIntervalMs: 0` to `CmsWorker` in
`packages/canopycms-cdk/worker/index.ts`. The AWS provider already enforces its own 5-minute
floor, so core's floor only shifts that floor's phase there. Core's floor stays on for
adopter-supplied providers, which is what it was added for.

Pin it with a composition test in canopycms-cdk (the real `createReactiveSecret` feeding
`refreshGitHubToken` with interval 0) that reproduces the timeline above and expects pickup at the
300s sync, not 600s.

## Why it was not fixed in the claims pass

The claims pass corrects prose, not code, and it surfaced this while measuring a docs claim.
