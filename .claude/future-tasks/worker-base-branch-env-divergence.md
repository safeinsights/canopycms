# Worker env-derived config can drift from the app's CanopyConfig (baseBranch, settingsBranch)

## Priority: P3

Surfaced by the protected-base-branch code review (2026-07-24), finding #8.
Defense-in-depth only; deferred. Extended 2026-07-30 by the canopy-hardening
epic review (PR #183) with a second instance of the same divergence class —
see "Same class: settingsBranch" below.

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

## Same class: settingsBranch (added 2026-07-30)

The hardening epic gave the worker `CmsWorkerConfig.deploymentName` /
`settingsBranch` (read from `CANOPYCMS_DEPLOYMENT_NAME` /
`CANOPYCMS_SETTINGS_BRANCH` in `packages/canopycms-cdk/worker/index.ts`) so
`pushSettingsBranches` pushes only the branch this deployment owns. CDK stamps
`CANOPYCMS_DEPLOYMENT_NAME` unconditionally for BOTH Lambda and worker, so
those two agree in any CDK deployment. But:

- An adopter who sets `settingsBranch` in `canopycms.config.ts` diverges: the
  Lambda's `getSettingsBranchName` short-circuits on `config.settingsBranch`
  (beating even the env-resolved deploymentName), while the worker only sees
  `CANOPYCMS_SETTINGS_BRANCH`, which no CDK prop stamps — the adopter must set
  it by hand or the worker's belt-and-suspenders settings push covers the
  wrong branch name forever. Bounded impact: the PRIMARY settings-push path
  (the `push-and-create-or-update-pr` task enqueued by
  `commitToSettingsBranch`) carries the Lambda-resolved branch name in its
  payload, so settings still reach GitHub; only the sync-cycle backstop is
  misaimed, plus its "foreign settings branch" warning would misfire on the
  deployment's own branch.
- Non-CDK deployments that set `config.deploymentName` without the env var
  have the same shape for `deploymentName` itself (worker defaults to 'prod').

Fix sketch: add a `settingsBranch` prop to `CanopyCmsService` that stamps
`CANOPYCMS_SETTINGS_BRANCH` for the worker (or teach the worker to read the
resolved name off a file the Lambda writes to EFS), and fold this into
whatever resolution (a)/(b)/(c) above lands for baseBranch.

Observability half (from the PR #183 independent review): when divergence
DOES happen, the only signal today is a per-cycle worker-log warning
("settings branch not owned by this deployment") that shell-less operators
never see. Surface "a local settings branch exists that this worker does not
own" into `worker-status.json` (`WorkerStatusReport`), so the admin System
Health panel can show it.

## Related

- `worker/cms-worker.ts` (backstop + `this.baseBranch`/`sanitizedBaseBranch`)
- `packages/canopycms-cdk/worker/index.ts`, `src/constructs/cms-service.ts`
- `docs/deploying-to-aws.md`
- [prod-remote-default-branch-detection.md](prod-remote-default-branch-detection.md) (adjacent base-branch config concern)
