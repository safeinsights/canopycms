---
priority: P3
adopters: NEITHER
summary: >-
  A pipe character inside a code span in a markdown table row splits the cell, and the text after it silently disappears. The root docs are clean; add a pipe-count check per table to `scripts/check-docs.mjs` and cover this index
---
# Unescaped `|` inside code spans silently splits markdown table cells

**Priority: P3 [NEITHER].** Docs render wrong and lose text; nothing executable breaks.

GFM parses table rows into cells **before** it parses inline code, so a `|` inside a backtick span
still splits the cell. Writing `` `||`, not `??` `` in a table row produces three cells, and the
trailing content lands in columns the table does not have. Prettier then widens the separator row to
match the longest row, which makes the damage look intentional. The text disappears; `prettier
--check` and `lint:docs` both pass.

Instances are fixed as they are found (the fix is `\|`), and the root docs are clean; the failure
recurs because the corruption is invisible in the source being edited.

## Fix

Add a check to `scripts/check-docs.mjs`, which already walks every doc and fails CI: for each
contiguous run of table lines (outside fenced code), compare each row's unescaped-pipe count with
the separator row's and report mismatches. It has no false positives worth tolerating. Include
`.claude/future-tasks/index.md`, which `check-docs.mjs` currently excludes and which is the most
table-heavy file in the repo.
