# EFS worker mount: enable TLS in transit

**RESOLVED 2026-10-06** (branch `fix/worker-efs-mount-parity`). The worker mounts the
`WorkspaceAP` access point at `/mnt/efs`, as the Lambda does, so that git paths one
process writes on EFS resolve for the other; efs-utils requires `tls` for an access-point
mount, so both the boot mount and the fstab line now carry it. Verified by the next
testing-dev deploy.

Flagged by PR #141 review (LOW).

## Problem

The worker's EFS mount in `packages/canopycms-cdk/src/constructs/cms-service.ts` (the
`mount -t efs` bootstrap command and the corresponding `/etc/fstab` line) does not pass
the `tls` mount option. NFS traffic between the worker EC2 instance and the EFS mount
targets is therefore unencrypted in transit — intra-VPC only, and encryption at rest is
already on, so exposure is limited, but `tls` (via efs-utils' stunnel wrapper) is the
documented EFS best practice for defense in depth.

## Fix direction

Add `tls` to the mount options in both places:

- The `mount -t efs -o tls,...` bootstrap command in the worker user-data.
- The `/etc/fstab` line that re-mounts on instance reboot (see the "EFS mount survives
  instance reboots" test in `cms-deploy.test.ts`).

## Scheduled

Folded into Workstream D's rebuild (2026-07-30) — see
[program-d-stack-rebuild.md](program-d-stack-rebuild.md), step 3. D tears the
deploy-test stack down and rebuilds it from scratch, which is exactly the
verification deploy this task was waiting for, so it rides along rather than
needing its own.

## Why deferred

This changes the deploy-proven mount path (the live prod-mode deploy in
[cms-service-deployment-test.md](cms-service-deployment-test.md)
exercised the current `mount -t efs` invocation end to end), so it needs its own
verification deploy rather than landing opportunistically alongside unrelated fixes.
