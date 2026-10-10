---
priority: P1
adopters: BOTH
summary: >-
  New 2026-10-09, the gap left by worker-git-config-from-shared-efs.md. A compromised CMS Lambda that races the worker can still run a command as it, and from there obtain the GitHub credential: by adding a filter or merge driver to a clone's git config between the worker's allowlist check and git's own read, or by editing a rebase the worker has stopped at a conflict (an exec line in git-rebase-todo, the strategy file). Persistent plants are refused. Move the worker's git in shared repositories into a process that has neither the credential nor the network
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
  signing and signature checks, push negotiation, submodule recursion and status, lazy fetches,
  and every transport except local paths. They hold even against a key written mid-operation.
- A check refuses a repository whose own config holds a key CanopyCMS never writes, or with a
  repository in a submodule, which git would otherwise run inside under that repository's config.

What is left needs a race, and the check cannot win one, because it reads before git does:

- **Keys whose names the attacker chooses:** `filter.<driver>.*` and `merge.<driver>.driver`,
  selected by `.gitattributes` or `.git/info/attributes`. Written between the check and git's
  read, a driver runs in any working-tree operation in a clone: `rebase`, `merge --ff-only` in
  the base-branch refresh, `checkout --theirs`, `sparse-checkout set`.
- **A rebase's own state.** While the worker's rebase is stopped at a conflict, an `exec` line
  added to `.git/rebase-merge/git-rebase-todo`, or a `strategy` file naming a program, runs on its
  `rebase --continue`. No check or pin reaches these files, which git must be able to write. A
  planted rebase state on its own is harmless: the worker aborts an interrupted rebase, which runs
  neither.
- **A submodule populated after the check** is kept out of `status` and the continuing commit by
  the pins, but `rm --sparse` of a conflicted one runs git inside it to absorb its repository.

Each runs as the worker user, which can reach IMDS, so it holds the instance role, which reads
the GitHub credential from Secrets Manager. A persistent plant is refused and reported, but an
attacker who can retry every sync cycle can win a race. An `include.path` naming a pipe, written
after the check, can also hang a rebase: denial of service only.

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
