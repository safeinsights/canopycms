---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-12. Collapsible list and block rows: a nested list's open rows reset when its parent row moves, collapsed rows give measuring custom renderers zero size, and a comment popover that opens inside a collapsed row picks its side from hidden anchors
---
# Collapsible list and block rows: follow-ups

## Priority: P3 [BOTH]

Found 2026-10-12 by the first review round of the collapsible lists and blocks PR
(`editor/fields/ItemList.tsx`).

## 1. Moving a row resets the lists nested in it

`FormRenderer.renderField` and `ObjectListField`'s `renderItem` key each field by its canopy
path, which includes the row index. Moving a row therefore remounts every field inside it,
including a nested `ObjectListField` or `BlockField`, whose `useItemExpansion` state goes back to
the defaults. Top-level rows keep their state, since that is keyed by list-item key.

**Fix:** key a row's children by field name within the row, checking that `FieldBoundary`'s crash
containment (keyed by path today) still holds; or lift expansion state into a store keyed by
list-item key.

## 2. Collapsed rows are `display: none`

A collapsed row's body stays mounted but hidden, so a custom field renderer that measures itself
on mount (a map, chart or code editor) starts at zero size. Options: `inert` plus zero height, or
re-measuring on reveal via a documented hook for custom renderers.

## 3. The comment popover's side inside a collapsed row

When a highlighted thread opens a field's popover as the field mounts inside a collapsed row,
`CommentThreadsPopover` chooses above or below (`choosePopoverSide`) from anchors that are still
hidden, and keeps that choice once the row opens. Position follows the anchor; only the side can
be wrong. **Fix:** re-choose the side once `anchors.above` becomes visible.
