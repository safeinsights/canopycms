---
'canopycms': minor
---

### List items and blocks carry a `_key`, and field comments follow it — **behaviour change**

<!-- migration
area: Reading
action: Rename fields named _key
row: List items and blocks gain a persisted `_key`
-->

**What changed.** Every object-list item and block now has a `_key`, a short string that names it
among its list's items. A move or an edit keeps it; Add, insert and Duplicate get new ones. The
editor writes keys into the file on the next save, so the first save of an entry adds a `_key`
line to each of its list items and blocks. Until then, reads give an item without one a key made
from its content. A comment on a field inside a list item or block now follows that item. A
comment whose item was removed stays on the entry, under "Comment on this entry", marked "On a
removed item".

Reads return `_key`: `TypeFromEntrySchema` types it as an optional `_key?: string` on list items
and blocks. A block keeps it beside `template`, never inside `value`. The unknown-field warnings
never report it.

**To adopt.** Rename any schema field named `_key`: the config now refuses it. If your code
checks content against a strict schema, allow `_key` on list items and blocks. Don't spread a list
item onto a DOM element (`<li {...item}>`), or it renders a `_key` attribute. `_key` also suits
React's `key` when rendering a list.
