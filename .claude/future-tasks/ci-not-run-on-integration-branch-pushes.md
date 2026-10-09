---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-04. `ci.yml` runs on `pull_request` and pushes to `main` only, so a merge into an `int-*` branch is never tested where it lands. Two individually green PRs combined into a red `int-202610-a` (an ACL test helper writing without `expectedVersion` against the OCC change), and it surfaced as an unrelated PR's failure. Fix: add `int-*` to `push.branches`
---
# [P3] CI never runs on an integration branch itself

New 2026-10-04, found while landing the workflow-push fix.

## What happens

`.github/workflows/ci.yml` triggers on `pull_request` and on `push` to `main` only. Merging a
PR into an `int-*` integration branch is a push to that branch, so the merged result is never
tested. Two PRs that are each green against the base they ran on can combine into a red
integration branch, and nothing reports it until the **next** PR's `pull_request` run tests
its merge ref, where it shows up as that unrelated PR's failure.

Measured on `int-202610-a` at `454ea992`: the logical-path ACL PR added a `writeEntry` test
helper that updates an entry without `expectedVersion`, and the OCC PR landed alongside it
makes a version-less update a 409. Each PR's CI passed alone; the base failed
`path-permissions-logical-paths.test.ts` on its own, and it surfaced as a failure of the
workflow-push PR, which touches neither file.

## Options

- Add `int-*` to `ci.yml`'s `push.branches`, so every merge into an integration branch is
  tested where it lands. Cheapest; costs one CI run per merge.
- Or require PR branches to be up to date with the base before merging (branch protection on
  `int-*`), so each PR's own run covers the merged result. Serialises merges.

The first is enough to make a red integration branch visible at the merge that caused it.
