---
priority: P3
adopters: BOTH
summary: >-
  A poisoned remote.git whose only ref GitHub lacks is this deployment's own settings branch stays refused for ever, because the push that would put it on GitHub runs in syncGit, after the boot that refuses. The worker could push that one branch through the mirror first, then replace remote.git.
---
# Push this deployment's own settings branch before refusing a poisoned remote.git

`CmsWorker.replacePoisonedRemoteGit()` (`packages/canopycms/src/worker/cms-worker.ts`) replaces a
`remote.git` that has no base branch only when the GitHub mirror contains every ref in it. The
likeliest ref GitHub lacks is this deployment's own `canopycms-settings-<deployment>` branch: the
Lambda commits permissions and groups there, and the worker pushes it in `pushSettingsBranches`
(`worker/git-sync.ts`). That push runs in `syncGit`, which runs only after a boot that succeeds, so
a poisoned `remote.git` holding an unpushed settings branch refuses on every restart. Recovery
still needs an operator with EFS access.

## Possible fix

In the refusal path, when the only refs at stake are this deployment's own settings branch
(`ensureSettingsBranch()`), push it to GitHub through `MirrorSession.pushToGitHub`, exactly as
`pushSettingsBranches` does, and then re-run the check. Refs belonging to other deployments, or
anything else, keep the refusal. Mind `[SYNC-M3]` in docs/concurrency.md, which explains how a
local settings branch is told apart from a foreign one.
