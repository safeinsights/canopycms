# [P3] Comment-marker guard: bare `reviewer` matches the product role name

**Status: RESOLVED** 2026-09-14 on `chore/encapsulation-b` (Chip B ratchet commit): both guard scripts now use `review (round|pass)` and `found by (a |the )?review`, the 20 role-name lines dropped out, no real marker was lost, and every package's `historyMarkers` budget is 0. Filed 2026-09-14 from the manager's review of the A2 comment-compression PR in
[baseline-quality-202609.md](baseline-quality-202609.md). Related:
[comment-guard-scope-gaps.md](../comment-guard-scope-gaps.md).

## Problem

`scripts/check-comment-budget.mjs`'s history-marker regex has a bare `reviewer` alternation, meant
to catch "a reviewer found …". The product has a reserved group named Reviewers, and 20
current-rule comments across `api/`, `authorization/` and `editor/` say "admin or reviewer",
"Admins and Reviewers" or "the Reviewers group". Those lines are the rule, not history, so the
marker count for those directories cannot reach zero and the ratchet floor for them stays at 20,
which can hide a real marker added later. `node scripts/check-comment-budget.mjs --markers` lists
the 20.

## Fix (in the ratchet PR)

Replace the `reviewer` alternation with `review (round|pass)` and `found by (a |the )?review`,
keep `review round`, re-run `--markers` to confirm the 20 role-name lines drop out and nothing real
is lost, then set `historyMarkers` for `canopycms` in `scripts/comment-budget.json` to 0.
