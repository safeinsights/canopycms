---
'canopycms': patch
---

### A locked branch's row lock shows on the hovered, focused or selected row

<!-- migration
area: Editing
action: None
row: Tree row lock shows on hover, focus or selection
-->

**What changed.** The lock in a content-tree row's menu slot was drawn on every row, repeating the branch pill and banner. It now appears on the row under the pointer, the focused row, the row with focus inside it, and the selected row, so a touch user sees the row they tapped. The slot stays reserved so rows do not shift, and the lock stays in the tab order and the accessibility tree on every row.
