---
priority: P2
adopters: NEITHER
summary: >-
  RESOLVED 2026-10-09, branch `chore/backlog-frontmatter`. Each task's priority, adopters and summary live in its own frontmatter, which `lint:tasks` validates; `pnpm tasks:index` prints the full tables, and `index.md` keeps only the hand-ranked lists
---
# Every backlog PR conflicts with every other one in `index.md`

**Priority:** P2 [NEITHER]. **Found:** 2026-10-09, raised by JP. **Resolved:** 2026-10-09 as proposed, except that `--index` prints to stdout only; nothing is written to disk.

## Problem

Every PR that files or resolves a task edits `index.md`, almost always at the same spot (the top of
a priority table), so two PRs in flight together conflict, and int merges keep re-conflicting. The
rule that makes this happen is `lint:tasks`'s orphan check: every open file must have a row in
`index.md`. GitHub's merge ignores custom merge drivers, so `.gitattributes merge=union` would not
help on the PR page.

## Proposal

Move each row's data into its task file and stop hand-editing the priority tables:

1. Each open task file starts with frontmatter: `priority` (P0–P3), `tags` ([KB]/[MKT]/[BOTH]/
   [NEITHER]), and `summary` (the row's one line). New files carry it from the start; a one-off
   script migrates today's rows into their files.
2. `scripts/check-future-tasks.mjs` validates the frontmatter in place of the orphan check, and
   gains `--index`, which prints the P0–P3 tables (or writes them to a gitignored
   `by-priority.md`) for anyone who wants the full view.
3. `index.md` keeps only the hand-curated parts: the legend, "Do next — ranked", and Active
   program. Only triage PRs edit those, and they are rare enough to merge in sequence.
4. Update the CLAUDE.md backlog rule and DEVELOPING.md's Future-Tasks Backlog Check to match.

A task PR then adds or moves files only, and two of them never touch the same lines. The cost is
losing the always-committed full table; `--index` regenerates it on demand. Committing a generated
table would bring the conflicts back.
