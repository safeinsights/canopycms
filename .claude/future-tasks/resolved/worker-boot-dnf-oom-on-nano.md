---
priority: P1
adopters: BOTH
summary: >-
  RESOLVED 2026-10-10, branch `fix/worker-boot-dnf-oom`, base `int-202610-b` (request 105). On the default one-nano `workerCapacity` the boot's `dnf upgrade --releasever=latest` was OOM-killed on three attempts in a row; the fourth of five succeeded. User data now turns on a 1 GiB swap file before the first dnf (idempotent, in fstab, `vm.swappiness` 10); every `retry` names its step when it gives up; an upgrade that exhausts its retries starts the worker on the AMI's packages, writes a worker.log line, and trips `workerUnpatchedAlarm` when `alarmTopic` is set. The required installs still fail the boot
---

# A t4g.nano worker's boot-time `dnf upgrade` is OOM-killed

**Status: RESOLVED 2026-10-10**, branch `fix/worker-boot-dnf-oom`; see the summary.

**Priority:** P1 [BOTH]. **Found:** 2026-10-10, request 105. An adopter on int.109 with the default
`workerCapacity` saw the kernel OOM-kill `dnf` (and once `yum`) on three consecutive `retry dnf
upgrade` attempts on each of two boots. The fourth attempt succeeded, so the boot was one attempt from
never starting the worker, and the first worker log line came about 4 m 54 s after launch instead of
about 2 m 15 s.

## Cause

Moving to the latest release discards the AMI's metadata cache. dnf then loads the release's full
repository metadata into its solver, whatever there is to upgrade. In an `amazonlinux:2023`
container the upgrade's cgroup peaked at about 615–620 MiB, whether it upgraded 65 packages or had
nothing to do. Capped at 400 MiB with no swap, it was OOM-killed on every attempt. With the 1 GiB
swap file and the same cap, the upgrade from 2023.6 to 2023.12 and the installs after it completed:
401 MiB of RAM, 325 MiB of swap at peak, no OOM kills.

## Resolution

`packages/canopycms-cdk/src/constructs/cms-service.ts`, worker user data:

- **`setup_swap` runs before the first dnf.** It skips a swap file that is already active, reuses a
  1 GiB file and recreates any other size, refuses when `/` has under 3 GiB free or `df` gives no
  number, then runs `fallocate`, `chmod 600` and `mkswap`, adds a guarded fstab line, sets
  swappiness 10 in `/etc/sysctl.d`, and runs `swapon` last, so swap is never on when it reports
  failure. A failure warns and the boot carries on.
- **`retry <step> <command…>`.** The message is `canopy-worker boot: '<step>' failed after 5
  attempts`.
- **The upgrade fails open; the installs fail closed.** The decision and its bound are in the comment
  above the upgrade. The CloudWatch agent install was already best-effort, after the worker starts,
  and keeps that.

Tests in `worker-hardening.test.ts` run user data up to the EFS mount under bash with stubbed `dnf`,
for the healthy, transient, exhausted-upgrade, failed-install and failed-swap paths.
`worker-down-alarm.test.ts` covers the new alarm.

## Checked only on EC2

A container cannot show these:

- systemd ignores fstab swap entries inside a container, so whether the swap returns after a
  reboot (via `swapfile.swap`) is unverified.
- XFS root and `fallocate`: the container ran on ext4.
- The nano's real headroom, around 400 MiB after boot services and the CloudWatch agent.
- That the CloudWatch agent ships the unpatched line written before it started (its source defaults
  `from_beginning` to true for a file with no saved position).
