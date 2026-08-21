# [P3] Add a `required_status_checks` rule to main's ruleset — repo settings, JP only

Split out of [resolved/infra-review-2026-08-release-pipeline.md](resolved/infra-review-2026-08-release-pipeline.md)
(2026-08-21). Everything in that task that could be fixed in code has been. This
is the half that lives in GitHub repo settings, which no agent should change.

## What the live config actually is

Checked read-only via `gh api` on 2026-08-21, because the original review's
claim deserved verification rather than repetition:

- Org ruleset **`require-pr`** (active, on `~DEFAULT_BRANCH`): requires a pull
  request with **1 approving review**, plus deletion and non-fast-forward
  protection. JP cannot bypass it (`current_user_can_bypass: "never"`). One
  GitHub App has `bypass_mode: always` — that is the release bot, by design, and
  it is what lets publish.yml push the version-bump commit.
- Repo ruleset **`main`** (active): deletion + non-fast-forward only.
- **Neither contains a `required_status_checks` rule.**

So "merges to main went green" is a habit, not a gate. Nothing blocks merging a
PR whose CI is red or still running — and `gh pr merge --auto` in this repo
merges *immediately*, because auto-merge has no required checks to wait on.

## What is already covered without it

publish.yml now waits for CI to conclude successfully on the merge commit before
its first `npm publish`. That closes the consequence that mattered — a red main
reaching the `latest` dist-tag — **including merge skew**, which branch
protection can never catch: two PRs that each pass CI alone can combine into a
red main, and no PR ever tested that combination.

## What adding the rule would still buy

- Feedback at the **merge button** rather than at publish time. Today a red merge
  lands on main and is caught minutes later by a failed publish run; with the
  rule it never lands.
- It protects any future consumer of main that is not publish.yml.

Cost: none at publish time. The friction is on merges — a PR cannot be merged
until checks report, which is the point.

## Fix direction

JP adds a `required_status_checks` rule to the repo-level `main` ruleset naming
the CI jobs that always report a conclusion. Note the trap ci.yml's own comments
already document: a job skipped by a workflow-level `paths:` filter never posts
a status, so a PR gates forever on "Expected — Waiting for status to be
reported". `dual-build` is deliberately structured to always run and filter
per-step for exactly this reason, so it is safe to require; anything newly
required must have the same shape.
