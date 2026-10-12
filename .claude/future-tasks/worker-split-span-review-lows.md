---
priority: P3
adopters: BOTH
summary: >-
  Three LOW gaps from the end-to-end review of the merged worker process split: a hand-installed gateway unit without `User=` passes the gateway's self-checks and runs as root; a compromised worker can kill an operator's `canopy-inspect` command; and the gateway quarantines and fsck's a bundle for a protected branch before refusing it. None reaches a secret
---

# [P3] LOW gaps from the worker split's end-to-end review

**Priority:** P3 [BOTH]. **Found:** 2026-10-11, by a single adversarial review of the whole merged
split (#497–#523) before the first int release carrying contract 2. That review found no path from a
compromised Lambda, even one also running as the worker, to the GitHub credential, the Clerk key,
the instance role, root or the gateway's mirror objects. These are what it did find. The outgoing
bundle-count gap is recorded under R5 in [worker-split-residual-risks.md](worker-split-residual-risks.md).

## The gaps

1. **A gateway unit with no `User=` passes the self-checks** (hand install only). `socket-access` in
   `packages/canopycms/src/worker/self-checks.ts` refuses only a socket owned by the worker's uid,
   and nothing checks that the gateway is not root. The generated unit always sets `User=`
   (`packages/canopycms-cdk/src/constructs/worker-units.ts`). A hand install that drops it runs the
   gateway as root, so an R3 parser bug would then run as root. Fix: the gateway's self-checks
   refuse uid 0.
2. **`canopy-inspect` shares the worker's uid and pid namespace,** so a compromised worker can kill
   an operator's one-shot inspect command. Whether it can also ptrace it is unverified. This is
   beyond [canopy-inspect-interactive-shared-pty.md](canopy-inspect-interactive-shared-pty.md); fix
   both together, likely with a dedicated inspect user or a separate pid namespace.
3. **Policy is applied after ingest** (a nit). For a bundle push to a protected branch, the gateway
   answers `need-objects`, then quarantines and fsck's the bundle, and only then refuses
   (`github-gateway.ts` `pushInSession`, `github-mirror.ts` `pushToGitHub`). There's no authority
   gain, but refused pushes still exercise the R3 parser surface. Checking `assertPushAllowed`
   before `need-objects` would avoid it. Note that this order follows plan §3.2.

## Related

- [worker-split-residual-risks.md](worker-split-residual-risks.md)
- [resolved/worker-shared-repo-git-process-split.md](resolved/worker-shared-repo-git-process-split.md)
