---
priority: P3
adopters: NEITHER
summary: >-
  `cms-worker.test.ts` "fails a push-branch task immediately on GitHub's workflow refusal" failed once (ENOENT on `.tasks/failed/<id>.json`) in a heavily loaded local run of the worker, http, admin and ai suites together, and passed alone right after. The test's fake GitHub runs a node `proc-receive` hook per push; under load the push likely times out or fails transiently, so the task is retried instead of failed. Find the timing it depends on and make it explicit
---
# The workflow-refusal push test flaked under load

**Priority:** P3 (one local occurrence, not yet seen in CI). **Found:** 2026-10-09, running the
targeted suites for the worker-down observability work while a reviewer also ran tests.

## What happened

`packages/canopycms/src/worker/cms-worker.test.ts`, describe `CmsWorker.pushBranchToGitHub()
[push-rejection classification]`, test "fails a push-branch task immediately on GitHub's workflow
refusal, naming the file on branch metadata": `fs.readFile(.tasks/failed/<id>.json)` threw ENOENT,
so the task had not landed in `failed/` after one `processTaskQueue()`. Rerun alone, the test passed
(3 of 3 in that describe).

The fixture refuses pushes through a `proc-receive` hook that execs `node` on a script. A slow hook
under load can trip the push's block timeout, which the worker treats as a retriable failure, so the
task goes back to pending rather than to `failed/`.

## What would close it

Confirm the failure mode (log the task's state on failure), then either give the fixture push a
timeout the test controls, or assert on the task wherever it lands and on its recorded error.
