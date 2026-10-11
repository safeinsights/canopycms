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
   - Why the margin is thin: in split mode a served gateway prepares as soon as it holds its
     socket, and that boot fetch against the revoked-token HTTPS server also arms a re-read.
2. **10 s `afterEach` hook timeouts**, all in cleanup: `fs.rm`, plus `closeServedGateways` in the
   bundle suite.
   - `github-gateway-bundle.test.ts` (`worker-http`), in "reports an abort that lands before the
     bundle header is read as the abort";
   - `cms-worker-sync-reconcile.test.ts`, "[SYNC-M2] one unreadable branch does not halt the rest
     of the sync cycle".
3. **The init-dist integration test.** `cli/init.integration.test.ts`, "CLI binary execution
   (dist)", failed twice in one run and then passed alone. Probably a concurrent build rebuilt
   `dist` mid-run, so likely not a real flake. Confirm before changing anything.

4. **A concurrent-operations test that rejects one operation.**
   - Where: `github-gateway-bundle.test.ts` (`worker-http`), "never deadlocks the mirror session,
     whatever runs beside it", which runs two fetches and three pushes of one branch at once and
     expects all five to fulfil.
   - Seen 2026-10-11, building PR 5: the fifth (a body-less push) rejected once, with the whole
     worker suite running under CI-like git. It passed four reruns alone. The error was not
     captured: it may be a legitimate `transient` under slow git (`ref-kept-moving`, or two
     fetch-reuse misses in `afterGitHubFetch`), or an ordering bug.
5. **A drain that hits its deadline in CI.**
   - Where: `cms-worker-drain.test.ts`, "a stop before the lock is taken leaves no lock behind
     once it resolves".
   - Seen 2026-10-11 in CI (PR 515, canopycms shard 3/3): the task queue was "still running 5s
     after the abort", and the drain's unspied `ERROR`/`INFO` lines failed the run as unhandled
     console output. All tests passed; it passed locally under `CI=true`.

## Shape of the fix

- Case 1: assert the property, a re-read that is bounded rather than hung, with a bound that
  leaves room for a loaded machine. Or use fake timers if the code path allows it.
- Case 2: give the heavy cleanups an explicit hook timeout, or give each test its own directory so
  cleanup is a single cheap `rm` that isn't contended.
- Case 3: reproduce with a concurrent `build` and decide whether the test should build into a
  private output directory.
- Case 4: reproduce under load, log the rejection's class and code, and decide whether the test
  should accept a transient outcome for that operation or the gateway is wrong.
- Case 5: spy the console for the deadline path too, or give the test's drain a deadline with
  room for a loaded runner.

## Related

- [branch-provisioning-kill-test-afterall-timeout.md](branch-provisioning-kill-test-afterall-timeout.md):
  the same class, an `afterAll` `fs.rm` under load.
- [worker-shared-repo-git-process-split.md](resolved/worker-shared-repo-git-process-split.md): the series
  that surfaced these.
