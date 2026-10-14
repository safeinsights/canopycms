---
priority: P2
adopters: NEITHER
summary: >-
  Once RELEASE_BOT_PRIVATE_KEY is a main-only `release` environment secret, the remaining way to reach it is code merged to main, and main's review can be gamed: the require-PR ruleset keeps stale approvals after a push, and Actions may approve PRs. JP settings decision: require last-push approval or dismiss stale reviews, turn off Actions approving PRs, consider code-owner review
---

# Make main's review hold, now that it guards the release-bot key

Found by the Opus review round of the release-environment PR (2026-10-12), in live settings
rather than in the diff.

## The gap

After [release-bot-key-environment-gate.md](release-bot-key-environment-gate.md) is done, only a
workflow running on `main` can read the key. So anyone who lands a workflow change on `main`
can send the key out, and `main`'s review is the only gate. Read with `gh api` on 2026-10-12:

- The org's require-PR ruleset requires one approval, with
  `dismiss_stale_reviews_on_push: false`, `require_last_push_approval: false` and
  `require_code_owner_review: false`. A writer can get a harmless PR approved, then push a
  changed `publish.yml` and merge. It also sets `require_extra_approval_for_unattributed_changes:
  true`; whether that blocks this path was not checked.
- `GET repos/safeinsights/canopycms/actions/permissions/workflow` returns
  `can_approve_pull_request_reviews: true`. A branch workflow with `pull-requests: write` may be
  able to approve its own PR. Plausible, not tested against rulesets.

## Options, JP's call

1. In the require-PR ruleset: turn on **Require approval of the most recent reviewable push** (or dismiss
   stale approvals). It is an org ruleset, so this affects every repository it targets.
2. Repository **Settings → Actions → General**: clear **Allow GitHub Actions to create and
   approve pull requests**. Check first that no workflow relies on it.
3. Optionally require code-owner review for `.github/` through `CODEOWNERS`.
