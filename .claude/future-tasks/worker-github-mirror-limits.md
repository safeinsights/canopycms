---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-10, from the review of the GitHub gateway's private mirror (worker/github-mirror.ts). Four limits that bite only large or unusual repositories: the mirror's cruft is never expired, so it grows for the instance's lifetime and keeps objects GitHub dropped; a pushed bundle whose history GitHub no longer references is fsck'd and can fail on an old malformed object; the silent connectivity walk after a fetch can outlast the inactivity timeout on a repository of millions of objects; and every instance fetches the whole repository, with a second copy on the root volume while remote.git is seeded
---

# [P3] Bound the GitHub gateway's mirror on large or unusual repositories

**Priority:** P3 [BOTH]. **Found:** 2026-10-10, by the review of
[worker-git-config-from-shared-efs.md](resolved/worker-git-config-from-shared-efs.md).

The mirror lives in the gateway's `StateDirectory=canopy-github`
(`/var/lib/canopy-github/github.git`) on the instance's 8 GiB root volume, and the gateway warns
once when it passes 2 GiB. None of these matters for a docs-site repository; each matters for a big one.

- **Cruft never expires.** `maintainMirror` (worker/github-mirror-upkeep.ts) runs
  `repack -a -d --cruft` with no `--cruft-expiration`, so every rebased-away commit and every
  staged-then-refused push object stays in the mirror. That is also what lets maintenance run
  beside sessions under its mutex alone: an expiring repack could delete an object a session or a
  quarantine is using. Expiring cruft needs another way to keep those alive; maintenance must
  never take a session, because a rebuild holds one while it waits on the mutex. The same
  retention is a security residual: a command run as the worker can push an object the mirror
  still holds but GitHub no longer references (a secret force-pushed away), by its object ID,
  until the instance is replaced.
- **fsck on an old history.** A pushed bundle carries history back to the tracking tips of its
  prerequisite branches (worker/github-transfer.ts), and the push's quarantine fetches it with
  `fetch.fsckObjects=true`. So a branch forked from a commit GitHub no longer references (a deleted
  branch) re-sends that history, and an old malformed object in it (`badTimezone`,
  `missingEmail`) fails the push every time. `fetch.fsck.<id>=ignore` for the classes GitHub accepts would fix it.
- **The silent walk.** `--progress` keeps git-process.ts's inactivity timer fed during a transfer,
  but `git fetch` ends with a connectivity walk that prints nothing. Around 0.2 s per 20k objects
  locally; a repository of millions of objects could exceed the gateway's inactivity bound
(`DEFAULT_TASK_TIMEOUT`) on a new instance's
  first fetch, every cycle. A longer, dedicated timeout for a mirror with no refs would remove it.
- **Bundle size.** A pushed bundle is capped (1 GiB by default, `maxBundleBytes`) and taken in
  one at a time, and the mirror no longer reads `remote.git` at all, so the Lambda cannot fill the
  root volume through it. An outgoing bundle (one pending at a time) is as large as what the
  caller's `have` lacks: the whole repository for a seed.

## Added 2026-10-10: a full fetch per instance after the process split

[worker-shared-repo-git-process-split.md](resolved/worker-shared-repo-git-process-split.md) moves the
mirror into a gateway that cannot see EFS; PR 2a already stopped it reading `remote.git`, in
single-process mode too. The mirror is on the root volume, and every bundle
roll replaces the instance, so a new gateway can no longer seed itself from `remote.git`: it
fetches the whole repository from GitHub once per instance (the boot prefetch). A whole-repository
bundle sits beside the mirror only while `remote.git` itself is seeded (a first deploy, or
replacing a poisoned one); on a roll the bundle holds only what `remote.git` lacks. The cost is
stated in `docs/deploying-to-aws.md`'s "The worker instance"; measuring both on a large
repository is still open.

