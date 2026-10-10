---
priority: P3
adopters: BOTH
summary: >-
  An unconfigured prod base branch is read from `remote.git`'s HEAD, which is set when the worker first clones and never follows a later change of GitHub's default branch. Refresh it at worker boot with `ls-remote --symref <github> HEAD`, run through the private-mirror path the worker git-isolation work introduces, never as a credential-bearing git command in a repository the Lambda can write
---
# Follow a change of GitHub's default branch at worker boot

## Priority: P3

Split from [prod-remote-default-branch-detection.md](resolved/prod-remote-default-branch-detection.md).

## Problem

With `defaultBaseBranch` and the CDK `baseBranch` prop both unset, the worker takes GitHub's
default branch once, when `remote.git` does not exist yet (`CmsWorker.resolveBaseBranch`), and
afterwards reads `remote.git`'s HEAD. The Lambda reads that same HEAD
(`GitManager.detectBaseBranch`). Changing the default branch on GitHub afterwards, as a cutover to
`production` would, changes neither: the deployment keeps forking from, rebasing onto and
protecting the old branch. Today's documented rule is to set `defaultBaseBranch` explicitly before
such a change (README config reference, `docs/adopter-migration.md`).

## Fix sketch

At worker boot, when the base branch is unconfigured, ask GitHub for its default branch
(`git ls-remote --symref <url> HEAD`, or the `repos.get` call first boot already makes) and, when it
differs from `remote.git`'s HEAD, log it and point HEAD at it before the boot sync.

- The credential-bearing command must run in the worker's private mirror
  (`worker/github-mirror.ts` on `fix/worker-git-config-isolation`), never against `remote.git` or
  any other repository on the shared filesystem.
- Lambda processes already running keep the value they read until they recycle; say so in the
  log line. A new base branch also retargets the rebase loop for existing editing branches forked
  from the old one, so decide first whether a detected change should apply automatically or only be
  reported in `worker-status.json` for an admin to confirm.

## Related

- `worker/cms-worker.ts` — `resolveBaseBranch`, `recordBaseBranchInRemoteHead`
- `git-manager.ts` — `GitManager.detectBaseBranch`
- `services.ts` — `resolvePendingBaseBranch`
