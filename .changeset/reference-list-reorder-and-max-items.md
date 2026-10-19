---
'canopycms': minor
---

### Reorderable list references, and `maxItems` on list fields — **behaviour change: a build fails on a list over its cap**

<!-- migration
area: Editing
action: Optional
row: Reorder list references; cap any list with maxItems
-->

**What changed.** A `type: 'reference', list: true` field now edits as rows in stored order, like an `object` list: drag a row or use its "…" menu to move or remove it, open a row to swap its entry in place, and pick from Add under the rows to append. Neither control offers an entry the list already holds. Any `list: true` field, and any `block` field, takes `maxItems`. The editor stops adding at the cap and says why, a save over it is refused, and a production build fails on an entry over it, naming the entry, field, count and cap. Adding `maxItems` to a list that already holds more therefore fails the build until an editor removes the extra items. `maxItems` on a field that holds no items is refused when the entry schema registry is created.

**To adopt.** Set `maxItems: 3` on the list field in its entry schema. See [Field Types](../README.md#field-types).
