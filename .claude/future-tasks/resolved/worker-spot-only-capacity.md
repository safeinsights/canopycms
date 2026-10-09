---
priority: P1
adopters: BOTH
summary: >-
  RESOLVED 2026-10-09, branch `fix/worker-graceful-replacement`, base `int-202610-b` (folded into request 95). New `workerCapacity` prop: the default is one on-demand t4g.nano (a behaviour and cost change from one-time spot); `{ type: 'spot' }` is a mixed-instances policy over t4g.nano/micro/small, price-capacity-optimized, capacity rebalancing on, Graviton-validated at synth. `spotMaxPrice` is removed (breaking). Spot still cannot guarantee a worker, since Auto Scaling has no spot-to-on-demand fallback: filed as worker-spot-on-demand-fallback.md. The adopter's InstanceMarketOptions override is now deletable.
---
# The worker is always a one-time spot `t4g.nano`

**Status: RESOLVED 2026-10-09**, branch `fix/worker-graceful-replacement`; see the summary.

**Priority:** P1 [BOTH]. **Found:** 2026-10-04, marketing-site request 49 (its first editor deploy);
still true at `fecc04a0`.

## Problem

`CanopyCmsService` builds the worker launch template with a fixed `T4G`/`NANO` instance type and
`spotOptions: { requestType: ONE_TIME, maxPrice }` (`canopycms-cdk/src/constructs/cms-service.ts`);
only `spotMaxPrice` is a prop. On the marketing site's first deploy the single-instance ASG failed 12
launches over 11 minutes for want of t4g.nano spot capacity in both zones (price was not the cause).
With no worker there is no `remote.git` on EFS, so `/edit` answered 500 on a deploy `cdk deploy`
reported as a success. The site now deletes `InstanceMarketOptions` from the emitted template, an L1
override of a construct internal that the next upgrade could break.

## Proposal

A `workerCapacity` prop: on-demand, or a mixed-instances policy with several instance types,
`capacity-optimized` spot allocation and an on-demand fallback. Keep spot as the default if wanted.
Add a note to `docs/deploying-to-aws.md` that a spot shortage shows as a 500 on `/edit`, not a failed
deploy. Related: [worker-not-ready-permanent-failure.md](../worker-not-ready-permanent-failure.md),
[worker-boot-loop-alarming.md](../worker-boot-loop-alarming.md).
