---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-11, from the worker process split's PR 6. The canopycms-cdk worker bundle is now at contract 2, so its `runWorker` always runs split: the single-process path (`buildSingleProcessWorker` in worker/run.ts, and the secret reading it shares with the gateway) is reachable only through the `bundleContract` test seam. Delete it, or say why an older contract stays supported in this bundle.
---

# [P3] Delete the CDK entrypoint's unreachable single-process path

**Found:** 2026-10-11, building PR 6 of
[worker-shared-repo-git-process-split.md](worker-shared-repo-git-process-split.md).

`packages/canopycms-cdk/worker/run.ts` chooses the split when `CANOPYCMS_GITHUB_GATEWAY_SOCKET` is
set, and refuses its absence once the bundle's contract (`WORKER_CONTRACT_VERSION`) reaches
`GATEWAY_SPLIT_CONTRACT`. PR 6 made that contract 2, so the bundle built from this tree never takes
the single-process path. A bundle older than the split is an older build of this file, with its own
copy of the path.

- `buildSingleProcessWorker` and the `bundleContract` seam exist only for `run.test.ts`, whose
  harness now defaults to the contract before the split to keep driving them.
- `readWorkerCredentials` stays: the gateway (`gateway-run.ts`) reads the secrets through it.
- The single-process unit user data still writes is for an OLDER bundle, so this deletion does not
  touch the template.

Decide: delete the path and the tests that drive only it, keeping each one that also covers the
gateway's reading of the same variables, or keep it and record why.
