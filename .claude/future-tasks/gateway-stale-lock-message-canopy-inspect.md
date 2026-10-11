---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-11, from the worker process split's docs PR. The worker's `lastGitSyncError` for a stale `remote.git/packed-refs.lock` (worker/github-transfer.ts, `stalePackedRefsLock`) says "remove that file" without saying how, while every other operator message on EFS routes through `canopy-inspect`. An operator following it from a root shell does exactly what the Security Model forbids. Append the same `canopy-inspect` advice the config-refusal messages carry
---

# [P3] Route the stale `packed-refs.lock` advice through `canopy-inspect`

**Found:** 2026-10-11, closing
[worker-shared-repo-git-process-split.md](resolved/worker-shared-repo-git-process-split.md) (§9 R9).

`stalePackedRefsLock` ends "Check that no git is running in remote.git, then remove that file."
`UntrustedRepoConfigError` and `refusePopulated` instead append worker/shared-repo-git.ts's
advice to run each command "as the worker's user and never as root", through
`/opt/canopy-worker/canopy-inspect`. `docs/deploying-to-aws.md` ("The worker instance") already
gives the `canopy-inspect rm` command; the message should too, through the same shared text, and
its test should pin it.
