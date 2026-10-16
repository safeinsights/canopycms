---
adopters: BOTH
summary: >-
  RESOLVED 2026-10-04, branch `fix/worker-push-workflow-permission`. The P1's premise did not hold: measured against real GitHub with an App token and a `repo`-only OAuth token, rebasing, merging or fast-forwarding across a base-branch workflow change is accepted, and only workflow content GitHub does not already hold is refused. No permission added. The narrow real case (a workflow edit made outside the editor) now fails the push task at once with the workflow file named
---
# [P1→resolved] Publishing a rebased branch is refused once the base branch changes a workflow file

## Status: RESOLVED 2026-10-04 — the premise did not hold; the narrow real case now fails legibly

Filed 2026-09-13 from review round 1 of the worker-credential epic, on the strength of two
public reports ([dianlight/hassio-addons#752](https://github.com/dianlight/hassio-addons/issues/752),
[aormsby/Fork-Sync-With-Upstream-action#44](https://github.com/aormsby/Fork-Sync-With-Upstream-action/issues/44))
of GitHub refusing "to create or update workflow … without `workflows` permission" after a
rebase or a fork sync. The fear: every content branch rebased across a base-branch workflow
change could no longer publish.

## What was measured (real GitHub, 2026-10-04)

A scratch private repository whose `main` changed `.github/workflows/ci.yml` after content
branches were published. Each scenario pushed with two credentials lacking the permission: a
`gh` OAuth token holding `repo` but not `workflow` (the documented PAT's scope set), and
GitHub Actions' `GITHUB_TOKEN` (an App installation token with `contents: write` only).

| Scenario | OAuth `repo` | App token |
| --- | --- | --- |
| Published branch rebased across the workflow change, `--force-with-lease` (the worker's path) | accepted | accepted |
| Published branch with the base merged in instead | accepted | accepted |
| First publish, rebased onto the current base | accepted | accepted |
| First publish, still on the old base | accepted | accepted |
| Control: rebased across a content-only base change | accepted | accepted |
| Published branch left behind the base, new editor commit | accepted | accepted |
| Published branch fast-forwarded to the base tip | accepted | accepted |
| New single-parent commit changing the workflow to content the repo already holds | accepted | accepted |
| **Control: new commit with workflow content GitHub does not hold** | **refused** | **refused** |

So GitHub refuses only workflow **content it does not already hold**. The worker fetches the
base from GitHub (`worker/git-sync.ts:406-411`, then `worker/rebase.ts:796`), so it carries
such content only when the branch holds a workflow edit of its own, normally from outside the
editor. Measured too, with the OAuth token only: a published branch carrying a direct-pushed
workflow edit, rebased onto a base that changed another line of the same file, auto-merged to
new content and was **refused**. Why the two public reports were refused was not established.

Not measured: a fine-grained PAT, a classic PAT proper, and a GitHub App other than Actions'
own. The live-App run in
[../github-app-auth-unexercised-against-real-github.md](../github-app-auth-unexercised-against-real-github.md)
can confirm the last.

## What shipped

- `workflowPushRefusalFile` (`utils/git.ts`) recognises GitHub's refusal, tested against both
  captured refusals (verbatim apart from the repository URL).
- `pushBranchToGitHub` raises `PermanentTaskError` naming the branch and the workflow file, on
  the plain, leased and stale-lease-retry pushes, so the task fails at once and the reason
  reaches System health and the branch list. Tested against a fixture whose proc-receive hook
  answers with GitHub's own reason text.
- The App keeps exactly `contents`, `pull_requests` and `metadata`; `docs/deploying-to-aws.md`
  states the measured rule instead of the "known gap".
