---
priority: P1
adopters: BOTH
summary: >-
  RESOLVED 2026-10-10, branch `feat/worker-template-contract`, base `int-202610-b` (adopter request 106, asks 2 and 3). `WORKER_CONTRACT_VERSION` (src/constructs/worker-lifecycle.ts, derived from the list of what each version requires of the unit) is stamped into the unit as `Environment=CANOPYCMS_WORKER_CONTRACT=<n>`, emitted as the `WorkerContract` stack output in parameter mode, and shipped beside the bundle as `worker/dist/index.js.contract`. The worker refuses a lower or missing stamp with `template too old for this bundle: needs worker contract N, unit has M (<settings>)`. deploying-to-aws.md's "Rolling the worker from CI" carries the gate recipe. Ask 3 reproduced: in parameter mode every bundle change alters the template (the asset fallback's key and sha256 in user data and the worker role's policy), so the contract, not the diff, decides. Template first.
---

# A bundle that needs a newer template must be detectable before it rolls

**Status: RESOLVED 2026-10-10**, branch `feat/worker-template-contract`; see the summary.

**Priority:** P1 [BOTH]. **Found:** 2026-10-10, an adopter's request 106. An int.110 bundle needs
the unit's `StateDirectory=`, and a parameter-only change set rolled it under an int.109 unit,
where it exited at start. The adopter's change-set gate accepted it as a normal bundle-only roll.

**Ask 3, reproduced.** Synthesize `workerCode: { source: 'parameter' }` twice, changing only
`worker/dist/index.js`. Three template values differ, and all of them come from the CDK-asset
fallback that runs while the parameter is empty: the worker role's `s3:GetObject` resource, and
the fallback object key and sha256 in the launch template's user data. Removing the fallback would
leave a first deploy with nothing to run, so the template diff can never answer "safe to roll".
The contract check does.

**Follow-up filed:** `worker-contract-cfn-enforced.md`, which has CloudFormation itself refuse the
change set.
