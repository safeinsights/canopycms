---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-09, from request 100. The worker's boot-time upgrade excludes the kernel, since a new kernel applies only at a reboot and nothing reboots the instance, so kernel security fixes reach it only with the AMI a deploy resolves; a weekly `workerMaxInstanceLifetime` recycle reuses the last deploy's AMI. Options: AL2023 kernel live patching (`kpatch`), or a reboot at the end of user data when `needs-restarting -r` says so
---
# [P3] Kernel security fixes reach the worker only with a deploy's AMI

**Priority:** P3 [BOTH]. **Found:** 2026-10-09, while resolving
[worker-instance-hardening.md](resolved/worker-instance-hardening.md).

## Problem

User data runs `dnf upgrade --releasever=latest --exclude='kernel*'` on every boot. The kernel is
excluded because a new kernel applies only at a reboot, which nothing performs, so an upgraded kernel package would cost boot time
and apply nothing. A replacement by `workerMaxInstanceLifetime`, a health check or a spot
interruption boots the AMI id CloudFormation resolved at the last deploy, so a stack that is not
redeployed runs that AMI's kernel indefinitely.

## Options

- Enable AL2023 kernel live patching (`kpatch-dnf`, `kpatch-runtime`), which applies fixes to the
  running kernel. It covers only the kernels AWS ships livepatches for.
- Upgrade the kernel too and reboot at the end of user data when `needs-restarting -r` reports it.
  The unit and the fstab entry already survive a reboot. This costs one more boot per replacement.
- Resolve the AMI at launch rather than at deploy (an SSM-parameter `resolve:ssm:` image id on the
  launch template), so every replacement boots the latest AMI. Check that CDK and the rolling update
  policy cope with an image id that changes outside CloudFormation.
