---
priority: P3
summary: >-
  Under concurrent load, a few worker tests exceed a wall-clock bound or a 10 s cleanup-hook
  timeout. They pass alone and in CI, but margins this thin flake in CI eventually. Widen the
  bounds that measure time against a busy machine, and give the heavy cleanups an explicit hook
  timeout or per-test directories
---

# Worker tests that fail only under load

Seen 2026-10-11 while building the worker process split's PR 4b, on a developer machine running
other heavy jobs. Each case passed when re-run alone, and the sequential gates and CI were green.

## The cases

1. **A wall-clock bound.**
   - Where: `packages/canopycms/src/worker/cms-worker-credential-refresh.test.ts`, "bounds a
     re-read that never settles…", which asserts `performance.now() - started < 1_000`.
   - Seen: 1148 ms in the `worker-http` project under CI-like git configuration.
   - Why the margin is thin: in split mode the served gateway prepares on its first call, and its
     boot fetch against the revoked-token HTTPS server also arms a re-read.
2. **10 s `afterEach` hook timeouts**, all in cleanup: `fs.rm`, plus `closeServedGateways` in the
   bundle suite.
   - `github-gateway-bundle.test.ts` (`worker-http`), in "reports an abort that lands before the
     bundle header is read as the abort";
   - `cms-worker-sync-reconcile.test.ts`, "[SYNC-M2] one unreadable branch does not halt the rest
     of the sync cycle".
3. **The init-dist integration test.** `cli/init.integration.test.ts`, "CLI binary execution
   (dist)", failed twice in one run and then passed alone. Probably a concurrent build rebuilt
   `dist` mid-run, so likely not a real flake. Confirm before changing anything.

## Shape of the fix

- Case 1: assert the property, a re-read that is bounded rather than hung, with a bound that
  leaves room for a loaded machine. Or use fake timers if the code path allows it.
- Case 2: give the heavy cleanups an explicit hook timeout, or give each test its own directory so
  cleanup is a single cheap `rm` that isn't contended.
- Case 3: reproduce with a concurrent `build` and decide whether the test should build into a
  private output directory.

## Related

- [branch-provisioning-kill-test-afterall-timeout.md](branch-provisioning-kill-test-afterall-timeout.md):
  the same class, an `afterAll` `fs.rm` under load.
- [worker-shared-repo-git-process-split.md](worker-shared-repo-git-process-split.md): the series
  that surfaced these.
