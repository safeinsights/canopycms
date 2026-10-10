---
priority: P1
adopters: BOTH
summary: >-
  New 2026-10-09, the gap left by worker-git-config-from-shared-efs.md. A compromised CMS Lambda that adds a filter or merge driver to a branch clone's git config after the worker's allowlist check and before git reads the config runs that command as the worker, in a rebase, base-branch refresh or sparse-cone change, and from there can obtain the GitHub credential. Move the worker's git in shared repositories into a process that has neither the credential nor the network
---

# [P1] Run the worker's shared-repository git without the credential

**Priority:** P1 [BOTH]. **Found:** 2026-10-09, while resolving
[worker-git-config-from-shared-efs.md](resolved/worker-git-config-from-shared-efs.md).

## What stays exploitable until this lands

The worker and the CMS Lambda both write `remote.git` and every branch clone on EFS. The worker
now protects itself in three ways (packages/canopycms/src/worker/shared-repo-git.ts and
github-mirror.ts):

- No git command carrying the credential runs in a shared repository. They all run in a private
  mirror on the instance's disk, so a planted `url.<x>.insteadOf`, `http.<url>.*` or credential
  helper never sees the token.
- `-c` pins turn off hooks (including config-defined ones), fsmonitor, credential helpers,
  signing, submodule recursion and every transport except local paths. They hold even against a
  key written mid-operation.
- An allowlist check refuses a repository whose own config holds a key CanopyCMS never writes.

What the pins cannot name is a key whose name the attacker chooses: `filter.<driver>.*` and
`merge.<driver>.driver`, selected by `.gitattributes` or `.git/info/attributes`. Only the check
stops those, and it reads the config before git does. So a Lambda that writes a driver between
the two runs it as the worker user during any working-tree operation in a clone: `rebase`,
`merge --ff-only` in the base-branch refresh, `checkout --theirs` in conflict resolution,
`sparse-checkout set`. That user can reach IMDS, so it holds the instance role, which reads the
GitHub credential from Secrets Manager. The window is narrow, and a
persistent plant is refused and reported, but an attacker who can retry every sync cycle can
win it.

## Fix

Run every worker git command in a shared repository in a process that has no credential and no
network: a second systemd unit (or a helper the worker execs) under its own user, with
`PrivateNetwork=yes` or `IPAddressDeny=any` (which also cuts IMDS), no `LoadCredential=` or
secret environment, and EFS through the same access point. The credentialed process keeps only
the mirror, the GitHub pushes and the Octokit calls.

Weigh:

- The rebase loop, base refresh and sparse-cone code call into branch metadata, locks and the
  task queue. Either the whole git-sync cluster moves into the unprivileged process and talks to
  the credentialed one only through the task queue on EFS, or the credentialed process calls a
  narrow "run this git argv in this repository" helper. The first is the cleaner trust boundary.
- A second user needs `posixUser` on the access point to stay uid 1000, or a second access point.
- Dev mode runs no worker unit, so it keeps the single process.
- `CanopyCmsService`'s user data writes the unit; a hand-installed unit needs the same change.

Until then, state the gap wherever the security model is described (docs/deploying-to-aws.md,
Security Model).
