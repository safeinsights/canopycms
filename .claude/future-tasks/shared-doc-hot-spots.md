---
priority: P3
adopters: NEITHER
summary: >-
  After changesets took CHANGELOG.md out of the merge-conflict path, the files that most PRs into an integration branch still both edit are CODEBASE_GUIDE.md (13 two-sided changes in 30 int merges, 2026-10-09 to 11), .claude/future-tasks/index.md (10) and scripts/docs-budgets.json (every doc's budget). A fragment layout like .changeset/ may fit each
---
# Shared docs that most integration-branch PRs still conflict on

Measured over PR merges into int-202610-b from 2026-10-09 to 2026-10-11: 30 of 55 PR branches had
to merge int-b in first. In those int merges, `git show --cc --name-only` (an upper bound on real
conflicts) counted these files changed on both sides:

| File | Two-sided changes | Why every PR touches it |
| --- | --- | --- |
| `CODEBASE_GUIDE.md` | 13 | The `update-codebase-guide` step after any new or renamed module |
| `.claude/future-tasks/index.md` | 10 | Hand-ranked rows, edited when a task is filed or resolved |
| `scripts/docs-budgets.json` | 18 | One JSON file holds every doc's word budget |

[adopt-changesets.md](adopt-changesets.md) removed `CHANGELOG.md`, the worst of them. Of 46
budget-file writes since 2026-10-06, 16 changed only that file's entry; the rest still land in
the shared JSON.

## Options to weigh

- **Budgets:** one small file per budgeted doc (`scripts/docs-budgets/<path>.json`), so two PRs
  raising different docs never touch the same file.
- **CODEBASE_GUIDE.md:** generate the per-module tables from each module's `AGENTS.md`, or split
  the guide per module, so the codebase-guide step edits the module's own file.
- **index.md:** already narrowed to hand-ranked lists; measure whether the remaining edits are
  ranking changes, which a fragment layout would not remove.

Measure again first: these counts come from one busy week on one branch.
