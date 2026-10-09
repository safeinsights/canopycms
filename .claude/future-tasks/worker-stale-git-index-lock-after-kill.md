---
priority: P3
adopters: BOTH
summary: >-
  A git process the worker leaves running at exit (a branch rebase still going after the 90 s drain deadline, which is never aborted) is SIGKILLed by systemd under `KillMode=mixed`, so git cannot remove its `.git/index.lock`. Nothing removes a stale `index.lock`, so that branch's interrupted-rebase recovery then fails every cycle until someone deletes the file.
---
# [P3] A git process killed at worker exit can leave a stale `index.lock`

**Found:** 2026-10-09, round 1 review of request 95 (`fix/worker-graceful-replacement`).

## Problem

The drain never aborts a branch rebase, since a rebase killed mid-branch is recovered lossily.
If one is still running after the 90 s deadline and the abort grace, `stop()` releases the lock and
the process exits. Under `KillMode=mixed`, systemd then SIGKILLs the remaining cgroup processes
(systemd.kill(5)), where the old `control-group` mode sent them SIGTERM, which git handles by
removing its lock files. The same leftover also follows any hard kill of the instance.

A rebase rarely runs that long, so this is unlikely. It is also unrecoverable without an operator:
nothing in `packages/canopycms/src` removes a stale `index.lock`.

## Options

- Have the interrupted-rebase recovery (`worker/rebase.ts`, the `isRebaseInProgress` block) remove
  an `index.lock` older than a few minutes, while it holds the provisioning and content-write locks.
- Before exiting, send SIGTERM to the worker's own remaining git children and wait briefly.

The same applies to `remote.git` maintenance: a repack SIGKILLed mid-run can leave `gc.pid`, and
git then refuses to gc that repository for 12 hours from any host.
