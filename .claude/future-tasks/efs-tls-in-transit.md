# EFS worker mount: enable TLS in transit

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

## Why deferred

This changes the deploy-proven mount path (the live prod-mode deploy in
[resolved/cms-service-deployment-test.md](resolved/cms-service-deployment-test.md)
exercised the current `mount -t efs` invocation end to end), so it needs its own
verification deploy rather than landing opportunistically alongside unrelated fixes.
