---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-11, from round 2 of PR 6's review (worker process split). In `workerCode: { source: 'parameter' }` mode the bundle comes from the construct's retained, delete-denied bundle bucket, but the instance files (the units and canopy-inspect, `worker/dist/instance-files.sh`) always come from the CDK bootstrap bucket, which `cdk gc` or a lifecycle rule can empty. A rollback or an older launch-template version then fails its boot and the group replaces instances in a loop. Copy the files into the bundle bucket under their sha256, or record the limitation.
---

# [P3] Keep the worker's instance files as downloadable as its bundle

**Found:** 2026-10-11, round 2 of the review of PR 6 of
[worker-shared-repo-git-process-split.md](resolved/worker-shared-repo-git-process-split.md).

`packages/canopycms-cdk/src/constructs/worker-bundle.ts` makes the instance files a CDK asset in
the bootstrap bucket. In asset mode the bundle has the same exposure. In parameter mode the
bundle's own bucket refuses deletes ("a bundle a running or rolled-back launch template names must
stay downloadable"), but the instance files do not get the same protection.

Failure:
1. `cdk gc` deletes a superseded template's instance-files object, or a bootstrap-bucket lifecycle
   rule expires it.
2. A CloudFormation rollback, or an operator pinning an older launch template, boots an instance
   that cannot download or check the files.
3. The ERR trap shuts the instance down, and the group replaces it in a loop.

Fix options:
- deploy the files into the bundle bucket too, as `canopy-instance-files/<sha256>.sh` (a
  `BucketDeployment`, or the CI upload recipe beside the bundle's);
- or document that parameter mode's rollbacks need the bootstrap bucket's objects kept.
