---
'canopycms': minor
---

### List items and blocks collapse, and reorder from one menu

<!-- migration
area: Editing
action: Editor UI tests
row: List items and blocks collapse
-->

**What changed.** Object-list items and block sections are collapsible rows with a drag handle
and a "…" menu: Move up, Move down, Duplicate, Remove. Blocks are added from "Add section" or the
"+" above any block; both menus show each template's `description`, as does an open block. A
`list: true` object takes an optional `itemLabel` ("team member") naming its items.

**To adopt.** Optionally set `itemLabel`. Browser tests that clicked a row's "Remove", "Move block
up" or the "Add block..." select use the row's `Actions for <title>` menu (`Actions for <title>, <secondary>` when the row shows
a second value) or "Add section".

**Now deletable.** Template labels that repeated the template's description.
