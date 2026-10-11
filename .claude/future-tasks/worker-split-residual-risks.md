---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-11, from the worker process split's §9. Three accepted residuals with no fix in flight: parser bugs in the gateway's git and node HTTP code on worker-chosen input (R3); sandbox layers the worker never checks at its own boot, `NoNewPrivileges` and the seccomp filter, which only `canopy-inspect` checks (R4); and the worker's denial-of-service levers on the gateway and its own liveness lines (R5). Each is in the Security Model; this file records what would narrow each
---

# [P3] Narrow the process split's accepted residual risks

**Found:** 2026-10-11, closing
[worker-shared-repo-git-process-split.md](resolved/worker-shared-repo-git-process-split.md) (§9
R3–R5). `docs/deploying-to-aws.md`'s "What the separation leaves open" states each for adopters.

- **R3, parser bugs.** The gateway runs git's bundle, index-pack and fsck code, and node's HTTP
  server, on input a compromised worker chooses. Not new (the pre-split mirror fetched
  Lambda-written objects), and bounded by the gateway's sandbox. Narrowing it means keeping git and
  node patched (every boot upgrades packages; the kernel moves only with the AMI), nothing more.
- **R4, a layer that silently does not apply.** The worker's boot self-checks (worker/self-checks.ts)
  prove the network cut, `ProtectProc` and `ProtectHome`, and that no secret is in its
  environment. They do not check `NoNewPrivs: 1` or `Seccomp: 2` in `/proc/self/status`, which
  `inspect-checks` does for `canopy-inspect`. Adding both to `workerSelfChecks` is cheap; the
  gateway's checks (EFS invisible, cores, socket access) could take them too.
- **R5, denial of service.** The worker can fill the gateway's incoming bundle cap one at a time,
  choose the gateway's GitHub fetch rate by pushing in a loop (within GitHub's limits), make a push
  wait for a credential re-read it armed (the join is capped at 15 s), and fake the `Syncing git...`
  lines the worker-down alarm counts. `completeLifecycle` is refused until the gateway's own watch
  sees a termination, so the worker can only cut a real drain short. An alarm on the gateway's log
  (its record of what reached GitHub) would catch a worker that is alive but stuck.
