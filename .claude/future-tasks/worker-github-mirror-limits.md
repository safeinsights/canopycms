---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-10, from the review of the worker's private GitHub mirror (worker/github-mirror.ts). Four limits that bite only large or unusual repositories: the mirror's cruft is never expired, so the root volume only grows; a publish whose history GitHub no longer references re-fetches it from remote.git under fsck and can fail on an old malformed object; the silent connectivity walk after a fetch can outlast the inactivity timeout on a repository of millions of objects; and seeding copies all of remote.git onto the root volume
---

# [P3] Bound the worker's GitHub mirror on large or unusual repositories

**Priority:** P3 [BOTH]. **Found:** 2026-10-10, by the review of
[worker-git-config-from-shared-efs.md](resolved/worker-git-config-from-shared-efs.md).

The mirror lives on the worker's 8 GiB root volume (`StateDirectory=`), and the worker warns once
when it passes 2 GiB. None of these matters for a docs-site repository; each matters for a big one.

- **Cruft never expires.** `repackBareRemoteIfNeeded` runs `repack -a -d --cruft` with no
  `--cruft-expiration`, so every rebased-away commit and every staged-then-refused push object
  stays in the mirror. That is also what makes `GitHubMirror.maintain()` safe outside the session
  lock: an expiring repack could delete an object between a staging fetch's quick check and the
  push. Expiring cruft means moving `maintain()` back under `exclusive()`.
- **fsck on an old history.** A publish fetches its commit from `remote.git` with
  `fetch.fsckObjects=true`. upload-pack sends everything not reachable from the mirror's own refs,
  so a branch forked from a commit GitHub no longer references (a deleted branch) re-sends that
  history, and an old malformed object in it (`badTimezone`, `missingEmail`) fails the push every
  time. `fetch.fsck.<id>=ignore` for the classes GitHub accepts would fix it.
- **The silent walk.** `--progress` keeps simple-git's inactivity timer fed during a transfer,
  but `git fetch` ends with a connectivity walk that prints nothing. Around 0.2 s per 20k objects
  locally; a repository of millions of objects could exceed `taskTimeoutMs` on a new instance's
  first fetch, every cycle. A longer, dedicated timeout for a mirror with no refs would remove it.
- **Seeding size.** An empty mirror seeds from `remote.git`, which the Lambda can fill; the
  volume is then the limit. The same Lambda can already fill EFS, so this is DoS of the same class.
