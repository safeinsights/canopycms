# Post-merge sync gaps: branch stays "submitted" and base-branch workspace goes stale

## Status: RESOLVED (2026-07-24, fix/post-merge-sync-gaps)

Both gaps fixed in `packages/canopycms/src/worker/cms-worker.ts`:

- **Gap 1 (merge-poll)**: `rebaseActiveBranches()` now calls a new
  `pollMergeState()` for every submitted/approved branch instead of a pure
  skip. It calls `octokit.pulls.get` for the branch's recorded
  `pullRequestNumber`; on `merged: true` it archives the branch via a new
  shared helper `buildMergedBranchUpdate()` (`branch-metadata.ts`), also
  adopted by the manual `markAsMerged` API (`api/branch-merge.ts`) so both
  paths produce identical archived-branch metadata. Closed-but-unmerged PRs
  record `pullRequestState: 'closed'` without archiving (admin decides next
  steps). A new `BranchMetadata.pullRequestState` field
  (`'open' | 'closed' | 'merged'`) and `mergedAt` ISO-timestamp field
  (`types.ts`) make PR resolution state visible in metadata; `open` is now
  stamped as soon as a PR is created (`updateBranchMetadata`), not just on
  first poll. Archived branches are never polled (no PR left to resolve).
- **Gap 2 (base-branch drift)**: new `refreshBaseBranchWorkspace()`, called
  in `syncGit()` right before `rebaseActiveBranches()`, fast-forwards
  `content-branches/<baseBranch>` to `origin/<baseBranch>` (`--ff-only`,
  since this clone must stay a linear mirror). Unprovisioned clones are
  skipped quietly (Lambda provisions on demand from the already-current
  `remote.git`); a dirty working tree is a loud `console.error` (nothing
  makes this clone read-only); a fast-forward failure (diverged local
  history — should never happen) is also loud and leaves the clone
  untouched. `rebaseActiveBranches()` now explicitly skips the base branch's
  own directory (routing it through the `--theirs` conflict-resolution loop
  would rewrite its history), and the two previously-silent `.git`-check
  skip paths now log.

Test coverage: `worker/cms-worker-merge-poll.test.ts`,
`worker/cms-worker-base-refresh.test.ts` (new), plus additions to
`worker/cms-worker-rebase.test.ts`, `branch-metadata.test.ts`,
`api/branch-merge.test.ts`.

**Correction to the original write-up**: the claim that "new branches fork
from stale main" was wrong. Code trace during the fix showed new branch
workspaces always clone fresh from `remote.git`
(`git-manager.ts` `initializeWorkspace` -> `cloneRepo`), which the worker's
`syncGit()` keeps current — they never copy the base branch's working-tree
clone. Base-clone staleness therefore only affected what editors *saw* when
viewing the base branch, not what new branches forked from.

Original description below.

---

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
  _[Correction, on resolution: false — new branches clone fresh from `remote.git`,
  not from this working tree; see the correction note at the top.]_

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
