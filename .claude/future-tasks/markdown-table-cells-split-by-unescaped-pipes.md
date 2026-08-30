# Unescaped `|` inside code spans silently splits markdown table cells

**Status:** Open. **Priority: P3** (docs render wrong and lose text; nothing executable breaks).

Found 2026-08-30 by a review of `feat/reproducible-build-artifacts`, which had just introduced
one instance of this bug and then swept for others.

## What

GFM parses table rows into cells **before** it parses inline code, so a `|` inside a backtick
span still splits the cell. Writing `` `||`, not `??` `` in a table row therefore does not
produce a cell containing that text — it produces three cells, and the trailing content is
pushed into columns the table does not have. Prettier then "fixes" the table by widening the
separator row to match the longest row, which makes the damage look intentional and permanent.

The failure mode that makes this worth a task rather than a typo fix: **the text disappears**.
In the instance that prompted this, the surviving row ended mid-sentence at `` — ` `` and the
load-bearing half of the note was simply gone. Nothing warns, `prettier --check` passes, and
`lint:docs` passes.

## Known instances

Counted with a separator-row-anchored, fence-aware pipe scan — an earlier hand count in this file
was wrong in three ways, which is itself an argument for automating the check.

- `CODEBASE_GUIDE.md` — **two** rows (`:62`, `:81`). The separator at `:59` has already been
  widened by Prettier, which makes ~34 healthy rows in that table look mismatched to a naive
  scanner and is what produced the earlier miscount of three.
- `.claude/future-tasks/index.md:223` — the `block-discriminator-precedence-disagreement` row,
  containing both `` `_type || template` `` and `` `||` ``.
- `.claude/future-tasks/index.md:338` — `O_CREAT|O_EXCL`.

**The branch that filed this task introduced a fourth instance and shipped it**, in the very row
announcing the bug — caught only by a later review round. That is the strongest available
argument for the check below: knowing about this failure mode is demonstrably not enough to avoid
it, because the corruption is invisible in the source you are editing.

Detect the rest with a cell-count comparison: for each contiguous run of table lines, compare
each row's unescaped-pipe count against the header's, and report mismatches.

## Shape

The mechanical fix is `\|`. The durable fix is a check in `scripts/check-docs.mjs`, which
already walks every doc and already fails CI — a row whose unescaped-pipe count disagrees with
its header's is an unambiguous signal with no false positives worth tolerating. Do that first,
then fix what it reports, or the next writer reintroduces it.
