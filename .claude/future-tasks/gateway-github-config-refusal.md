---
priority: P2
adopters: BOTH
summary: >-
  New 2026-10-10, decision D10 of the worker process-split plan. Whether a push carrying new workflow files lands depends only on the GitHub credential's scope (a classic PAT usually can). A worker/gateway-side refusal of new content under `.github/` was designed and attacked for six review rounds; the best design reached is recorded here. Until then, docs recommend a credential without workflow scope
---

# [P2] Refuse new `.github/` content on the worker's pushes

**Found:** 2026-10-10, planning
[worker-shared-repo-git-process-split.md](worker-shared-repo-git-process-split.md) (its D10).

## Why it was taken out of the split

Rounds 2 to 7 of the plan's adversarial review each bypassed a path-matching rule or found a
legitimate push it wedged. Case variants, renames, C-quoted names and a `.` tree entry got past
a path test. A rebased branch carrying a developer's direct `.github` edit was wedged. None of
that is the credential gap the split closes, and GitHub already refuses workflow changes from a
credential without `workflow` (PAT) or `workflows: write` (App) scope.

## The best design reached (verified on git 2.50.1)

- New commits: `git rev-list --stdin <sha>` fed one `^<tip>` line per mirror `refs/heads/*` tip.
  A `--not` before `--stdin` does not negate stdin revisions.
- Read each new commit's root tree, and its parents', through one per-push `cat-file --batch`
  with `GIT_NO_REPLACE_OBJECTS=1`. Take the entries whose name, ASCII-case-folded, is `.github`.
- Compare one level down: accept only if every (name, mode, oid) entry of the commit's `.github`
  tree exists in a parent's or a current mirror head's `.github` tree. A root commit must have no
  `.github` at all. Comparing the whole `.github` subtree object ID instead wedges a rebased branch
  that carries a developer's `.github` edit when base also changed `.github`.
- A 5 000-commit cap and a per-tree cache.
- Known cost: an attacker can keep any current `.github` set alive by parking it on a branch of
  its own.

Needs its own two adversarial review rounds before it ships.
