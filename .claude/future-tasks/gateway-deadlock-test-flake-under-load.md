---
priority: P3
adopters: NEITHER
summary: >-
  New 2026-10-11. `github-gateway-bundle.test.ts`'s "never deadlocks the mirror session, whatever runs beside it" failed once in the worker-http project when the whole worker suite ran under CI-like git (one of its five concurrent operations rejected) and passed four isolated reruns. Find which operation rejects under load and why, then either make the test hold that outcome or fix the gateway.
---

# [P3] The gateway's no-deadlock test rejected one operation under load

Seen 2026-10-11 while gating the worker process split's entry roles. The command was
`vitest run --project node --project worker-http src/worker`, under `GIT_CONFIG_NOSYSTEM=1`, an
empty `GIT_CONFIG_GLOBAL` and pinned author and committer identities. The parallel suite's
cumulative test time was about 29 minutes.

- **Test:** `packages/canopycms/src/worker/github-gateway-bundle.test.ts`, "never deadlocks the
  mirror session, whatever runs beside it". It runs two fetches and three pushes of one branch
  concurrently, then expects all five to fulfil.
- **Seen:** the fifth (a body-less push) rejected. The error was not captured. It may be a
  legitimate `transient` (`ref-kept-moving`, or a fetch-reuse miss twice in a row:
  `afterGitHubFetch`) under slow git, or a real ordering bug.
- **Not seen:** in four reruns of the test alone, under the same git environment.

**To do:** rerun the whole worker-http project under load until it reproduces, log the
rejection's class and code, and decide whether the test should accept a transient outcome for
that operation or whether the gateway is wrong.
