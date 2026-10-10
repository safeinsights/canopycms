---
priority: P1
adopters: BOTH
summary: >-
  RESOLVED 2026-10-09, branch `fix/worker-instance-hardening`, base `int-202610-b` (request 100, from an adopter's audit of the 0.0.68-int.108 `cms-service`). The worker instance requires IMDSv2 (hop limit 1); its bundle is one file whose sha256 user data checks before installing, readable as that one object; EFS has a policy refusing clients without TLS or IAM (`efsEnforceIamAndTls`, default true, a two-deploy upgrade for live stacks) and the worker mounts `tls,iam`; the managed EFS client policy is gone; the root volume is encrypted gp3; every boot upgrades to the latest AL2023 release (kernel excluded) and `workerMaxInstanceLifetime` recycles it weekly; the systemd unit is sandboxed; `efsBackup` defaults on. Kernel fixes between deploys are filed as worker-kernel-fixes-between-deploys.md
---
# Harden the CMS worker instance

**Status: RESOLVED 2026-10-09**, branch `fix/worker-instance-hardening`; see the summary.

**Priority:** P1 [BOTH]. **Found:** 2026-10-09, request 100, an adopter's audit of the worker
instance in `canopycms-cdk`'s `CanopyCmsService`. The worker holds the GitHub credential.

## Problem

The worker launch template set no `MetadataOptions` (IMDSv1 allowed on a public-subnet instance),
`workerAsset.grantRead` granted read on the whole CDK bootstrap bucket, user data unzipped the
bundle with no integrity check, EFS had no file-system policy (the worker mounted anonymously, with
TLS only), the worker role carried the account-wide `AmazonElasticFileSystemClientReadWriteAccess`,
the root volume's encryption was left to the account default, nothing patched the instance between
deploys, the systemd unit had no sandboxing, and EFS had no backups.

## Resolution

Each item is pinned by `packages/canopycms-cdk/src/constructs/worker-hardening.test.ts` and
described for adopters in `docs/deploying-to-aws.md#the-worker-instance`; the two-deploy upgrade is
in `docs/adopter-migration.md`. Decisions: `ProtectHome=tmpfs` rather than `yes` (git warns on
every call otherwise, confirmed in an `amazonlinux:2023` container under systemd), `/opt/canopy-worker`
left read-only, a full `--releasever=latest` upgrade rather than security-only (a security-only
pass leaves dnf's release lock, so the installs after it still come from the AMI's release), no
`dnf-automatic`. The public subnet stays, as a documented cost trade-off.
