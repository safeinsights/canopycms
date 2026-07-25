# Worker base-branch backstop can drift from config.defaultBaseBranch

## Priority: P3

Surfaced by the protected-base-branch code review (2026-07-24), finding #8.
Defense-in-depth only; deferred.

## Problem

The worker's new head==base backstop (`worker/cms-worker.ts:~611`) compares the
submitted branch against `this.sanitizedBaseBranch`, derived from
`CmsWorkerConfig.baseBranch` — which the CDK worker entrypoint
(`packages/canopycms-cdk/worker/index.ts:86`) populates from the
`CANOPYCMS_BASE_BRANCH` env var (`cms-service.ts:382`), NOT from the app's
`CanopyConfig.defaultBaseBranch`. Nothing in the CDK package or
`docs/deploying-to-aws.md` derives the env var from `canopycms.config.ts`.

If an adopter changes `defaultBaseBranch` in config without also updating
`CANOPYCMS_BASE_BRANCH`, the worker backstop silently keeps protecting the old
name. Impact is bounded: the primary layers (the `submittableBranch` guard and
`syncSubmitPr`) key off the live, correct `config.defaultBaseBranch` and reject
before enqueueing, and normal enqueuers pass an explicit `baseBranch` payload
that the worker prefers over `this.baseBranch`. So the stale worker check only
matters when those upstream layers are bypassed (e.g. a task queued before the
protection shipped) AND the base branch was renamed without updating the env var.

## Fix sketch

Either (a) document/wire `CANOPYCMS_BASE_BRANCH` to be derived from the same
source as `defaultBaseBranch` in the CDK construct so they can't drift, or
(b) have the worker read the base branch from the task payload / app config
rather than a construction-time env var, or (c) at minimum add a CDK synth-time
check or doc note. Lowest-effort: doc note + CDK wiring.

## Related

- `worker/cms-worker.ts` (backstop + `this.baseBranch`/`sanitizedBaseBranch`)
- `packages/canopycms-cdk/worker/index.ts`, `src/constructs/cms-service.ts`
- `docs/deploying-to-aws.md`
- [prod-remote-default-branch-detection.md](prod-remote-default-branch-detection.md) (adjacent base-branch config concern)
