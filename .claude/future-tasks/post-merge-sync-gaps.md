# Post-merge sync gaps: branch stays "submitted" and base-branch workspace goes stale

Found during the deployment-test epic (2026-07-24), on the live prod deployment, by
merging a real content PR (canopycms/deploy-test PR #1) and observing the deployed
editor afterward.

## What works (context)

After submit, the worker correctly:
- pushed the branch to GitHub and opened the PR,
- wrote the PR number + URL back to branch metadata / `branches.json`, so after the
  next `syncGit` cycle the editor's Branches panel shows a **"PR #1"** badge and a
  **"View PR"** link on the branch. That writeback path is verified good.

## Gap 1 — branch status does not auto-update to merged/archived

After PR #1 was **merged and its head branch deleted on GitHub**, the deployed
editor's Branches panel still shows `feature-deploy-test-edit` as **SUBMITTED**
(with Withdraw / Request-changes actions), not merged/archived. The worker's
`syncGit` fetches + prunes remote refs but does not poll PR merge state, and nothing
calls `markAsMerged` (branch-merge.ts) automatically. So a merged branch lingers as
"submitted" in the UI indefinitely until an admin manually archives it.

Decide: should the worker detect merged PRs (Octokit PR state, or "head branch gone
from remote after being submitted") and transition the branch to archived/merged? Or
is manual archival intended? At minimum the editor should distinguish "submitted,
open PR" from "submitted, PR merged".

## Gap 2 — base-branch (main) workspace is stale after an upstream merge

The deployed editor's `main` view still renders the PRE-merge content ("Home")
after PR #1 merged the new title into GitHub `main`. The worker synced the merge
into the EFS bare `remote.git` (verified: `remote.git` main advanced; EFS write
burst on the 04:11 sync cycle), and the STATIC build off GitHub main correctly shows
the new title — but the editor's **`content-branches/main` working-tree clone** (what
the Lambda reads to display and to fork new branches from) was not updated, so:
- editors see stale base content, and
- **new branches fork from stale main**, which will cause needless rebases/conflicts.

`rebaseActiveBranches` skips submitted/approved/archived/dirty branches; the base
branch's own working tree does not appear to be refreshed from `remote.git` on the
sync cycle. (Root cause to confirm on a host with shell access — this deploy's SSO
role can't SSM in: is it the clone that's behind, or a stale content-index cache?)

Decide: the worker (or a sync step) should fast-forward the base-branch working-tree
clone to the synced `remote.git` base after upstream merges, so the editor's base
view and new-branch forks start from current content.

## Why it matters

Both are core to the multi-editor prod workflow the CMS exists for: after any content
PR merges, the next editor should see current base content and the merged branch
shouldn't look like it still needs review. P1 for a real customer deploy.

## Repro

deploy-test (canopycms/deploy-test) on the live stack: create branch, edit, submit,
merge the resulting PR on GitHub, wait one worker `syncGit` cycle (~5 min), reload
`/edit` → branch still "SUBMITTED", `main` still shows old content; meanwhile
`CANOPY_BUILD=static` build off GitHub main shows the new content. Relates to
[[project-deployment-test-epic]].
