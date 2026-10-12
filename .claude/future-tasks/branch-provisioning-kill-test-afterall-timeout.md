---
priority: P3
summary: >-
  branch-provisioning.kill.integration.test.ts times out in its afterAll (`fs.rm` of its temp
  root, 10 s hook timeout) when the full worker suite runs under concurrent load on a developer
  machine; it passes alone and in CI. Bound or speed up its cleanup so a loaded local run stays green
---

# [P3] The provisioning kill test's cleanup times out under load

**Found:** 2026-10-11, while gating PR 4a of the worker process split (#508), which does not
touch the file.

## What was seen

- `pnpm exec vitest run --project node --project worker-http src/worker src/branch-provisioning src/cli src/test-utils`
  on a macOS developer machine, with a package build and the canopycms-cdk worker tests running
  at the same time: `src/branch-provisioning.kill.integration.test.ts` failed both times
  (normal and under CI-like git) with `Hook timed out in 10000ms` at its `afterAll`, which only
  runs `fs.rm(tmpDir, { recursive: true, force: true })`.
- Every test in the file passed in both runs (it reports as a failed file, not a failed test).
- Run alone it passes, 32/32, in about 38 s. CI (Linux, sharded) was green on the same commit.

## Likely cause

The suite SIGKILLs provisioning children mid-clone and leaves their trees under one temp root;
removing that root is a large recursive delete, which a loaded disk can push past vitest's 10 s
default hook timeout.

## Fix options

- Give that `afterAll` an explicit timeout, sized to the tree it removes.
- Or remove each test's own directory in an `afterEach`, so no single hook deletes everything.
- Or leave removal to the run-owned temp root (the repo root's `vitest.tmpdir.ts` deletes it at teardown).
