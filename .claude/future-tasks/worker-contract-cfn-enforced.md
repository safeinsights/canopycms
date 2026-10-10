---
priority: P3
adopters: BOTH
summary: >-
  Have CloudFormation itself refuse a parameter-only change set whose worker bundle needs a newer template: a `WorkerBundleContract` parameter whose AllowedValues are 0..WORKER_CONTRACT_VERSION. Today an adopter's gate compares `index.js.contract` with the `WorkerContract` output, and the bundle's start-up check is the backstop.
---

# CloudFormation-enforced worker contract

**Priority:** P3 [BOTH]. **Found:** 2026-10-10, while resolving
[worker-bundle-template-contract](resolved/worker-bundle-template-contract.md).

`workerCode: { source: 'parameter' }` stacks publish their worker contract as the `WorkerContract`
output, and the bundle ships its need as `worker/dist/index.js.contract`. Comparing the two is left
to the adopter's change-set gate (the recipe in docs/deploying-to-aws.md, "Rolling the worker from
CI").

**The option.** Add a second parameter, `WorkerBundleContract`, with
`AllowedValues: ['', '0', …, String(WORKER_CONTRACT_VERSION)]`. CI passes the bundle's contract
beside its sha256. A template too old for the bundle then rejects the change set at creation, and
a template from before the parameter rejects it as an unknown parameter, since CloudFormation
refuses a parameter the template does not declare.

**Why it waited.** It is a second parameter that CI must pass and the gate must allowlist, and it
protects nothing when CI omits it. Do it only if an adopter's gate cannot run the shell check.
