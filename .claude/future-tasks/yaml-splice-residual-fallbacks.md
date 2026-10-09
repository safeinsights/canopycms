---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-07, from review of the source-preserving YAML saves. Rare shapes still fall back to a whole-file re-print (a pinned comment run re-indented into a deeper scalar, dropping a compact item's first key when the next key has a comment), and one comment line can get stacked indentation. Data is right in every case
---
# [P3] Source-preserving YAML saves: rare shapes that still re-print, and one cosmetic indent

Found 2026-10-07 by the review rounds on the source-preserving write path
(`packages/canopycms/src/utils/yaml-source-splice.ts`). Every case keeps the right data; the cost
is formatting only — a whole-file re-print (today's `doc.toString()`), or extra indentation on one
comment line.

## Shapes that still fall back to a whole-file re-print

- **A pinned trailing comment run re-indented into a deeper scalar.** `outdentedCommentEdits`
  raises a run's shallower lines to its deepest comment. When a deeper line is a scalar's own
  comment (`title: Hero\n      # note on title\n    # end of hero`) or the run sits under a block
  scalar, the raised line is read as that scalar's comment or content, so `printsAs` refuses the
  splice. Fix: re-indent only up to the indent of the collection the run is attached to, and skip
  lines inside any scalar's source range.
- **Dropping a compact item's first key when the next key has a comment above it**
  (`- t: x\n    # about v\n    v: 1`, drop `t`): `promoteToInline` refuses, and `yaml`'s own
  re-render (`- # about v`) reads back with the comment on the item, so the item-level fallback
  fails `printsAs` too. Fix: emit a non-compact item (`-` then the retained block).
- **Explicit `? key` pairs, tagged sequence items (`- !!str 1`), flow collections being edited,
  and files using anchors or aliases** are not spliced by design.

## Cosmetic

- **Stacked indentation.** A pinned comment line at indent 0 inside two nesting levels whose
  neighbours both change gets a zero-width insertion from each level, so it lands at 12 spaces
  where 6 are expected. `uncovered()` ignores zero-width covering edits. Fix: dedupe re-indent
  edits by line start, or treat an identical `[start, end)` as covered.

## Not fixable here

- `yaml` reads a comment that follows a pinned trailing run (for example, a blank line and then the
  next item's own comment) as the PREVIOUS item's. Once the item between them is removed, no text
  reads back with that comment on the next item, so a later save that removes or moves the
  previous item takes the comment with it. `toString()` behaves the same way.
