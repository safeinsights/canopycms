---
priority: P2
adopters: BOTH
summary: >-
  New 2026-10-10, decision D9 of the worker process-split plan. Through the task queue a compromised CMS Lambda can push to, force-push (via a planted `historyRewrittenFrom` lease) and delete ANY non-protected GitHub branch, and open PRs from them, which run the adopter's `push`/`pull_request` workflows. Decide whether new CMS branches get a prefix (say `cms/`) the worker or gateway refuses to step outside; needs JP
---

# [P2] Confine CMS GitHub writes to a CMS branch namespace

**Found:** 2026-10-10, planning
[worker-shared-repo-git-process-split.md](worker-shared-repo-git-process-split.md) (its D9).

## The exposure

The worker pushes, lease-pushes and deletes whatever branch a task names, and opens PRs from it.
A compromised Lambda writes the task queue, `remote.git` and `branch.json` (the lease marker), so
it can rewrite any branch the credential can write: `release/*`, a developer's branch, a branch
that triggers a deploy. The base branch is a separate, narrower fix (D4 of the same plan). The
split does not change this: the gateway's API is exactly what the queue already offers.

## Options

- **(a) A prefix for new CMS branches,** with the worker (and later the gateway) refusing every
  push, lease or delete outside it. Existing branches are allowed by an explicit list taken once
  from the branch registry. A product change: branch names change for editors.
- **(b) Ownership records on GitHub,** such as a `refs/canopycms/owned/<branch>` ref the worker
  maintains: refuse a branch whose GitHub tip is not one CanopyCMS pushed. No naming change, but
  more moving parts.
- **(c) Leave it,** and document GitHub rulesets on every branch that matters as the control.

Recommendation when filed: (a), decided with JP.
