---
'canopycms': patch
---

### An item moved into a list no longer takes the identity of the copy beside it

<!-- migration
area: Worker
action: None
row: A moved-in item keeps its own identity
-->

**What changed.** When an editor duplicated a list item, moved the copy to another list, and later moved the original into that list above the copy, the field merge could read the original as the copy. The base's edit of the copy then landed on the original with no conflict shown, and a base deletion of the copy was reported against the wrong item. An item now takes another's identity from a look-alike key only where no item on its side holds that item's own key, and never when the key belongs to an item of another list.
