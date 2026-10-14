---
priority: P2
adopters: BOTH
summary: >-
  New 2026-10-10, decision D9 of the worker process-split plan. Through the task queue a compromised CMS Lambda can push to, force-push (via a planted `historyRewrittenFrom` lease) and delete ANY GitHub branch outside the gateway's protected set, open PRs from them, which run the adopter's `push`/`pull_request` workflows, and update or close any PR by number. Decide whether new CMS branches get a prefix (say `cms/`) the worker or gateway refuses to step outside; needs the maintainer
---

# [P2] Confine CMS GitHub writes to a CMS branch namespace

**Found:** 2026-10-10, planning
[worker-shared-repo-git-process-split.md](resolved/worker-shared-repo-git-process-split.md) (its D9).

## The exposure

The worker pushes, lease-pushes and deletes whatever branch a task names, and opens PRs from it.
A compromised Lambda writes the task queue, `remote.git` and `branch.json` (the lease marker), so
it can rewrite any branch outside the gateway's protected set (the base branch, GitHub's default
branch and `protectedBranches`: worker/branch-policy.ts), which an adopter must list by hand: a
developer's branch, a branch that triggers a deploy. The gateway's API is exactly what the queue
already offers.

Two more levers of the same kind:
- **Pull requests by number.** `updatePullRequest` (which also closes one) and
  `convertPullRequestToDraft` take the number from the task payload (task-runner.ts), and
  `getPullRequest` takes it from `branch.json` (rebase.ts, `pollMergeState`), which the Lambda
  also writes. So a planted task can retitle, draft or close any PR in the repository, not only
  CanopyCMS's own.
- **A settings branch named without the reserved prefix.** `BranchPolicy`'s settings rules match
  `canopycms-settings-` only, and the gateway is never given `CANOPYCMS_SETTINGS_BRANCH`
  (gateway.env.example), so a deployment's own configured name without the prefix is an ordinary
  content branch to the gateway. Protecting it exactly needs the gateway to know the name.

## Options

- **(a) A prefix for new CMS branches,** with the gateway's `BranchPolicy` refusing every
  push, lease or delete outside it. Existing branches are allowed by an explicit list taken once
  from the branch registry. A product change: branch names change for editors.
- **(b) Ownership records on GitHub,** such as a `refs/canopycms/owned/<branch>` ref the worker
  maintains: refuse a branch whose GitHub tip is not one CanopyCMS pushed. No naming change, but
  more moving parts.
- **(c) Leave it,** and document GitHub rulesets on every branch that matters as the control.

Recommendation when filed: (a), decided with the maintainer.
