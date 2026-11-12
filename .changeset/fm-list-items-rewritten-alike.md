---
'canopycms': patch
---

### List items rewritten to read like one deleted item no longer conflict as a whole list

<!-- migration
area: Worker
action: None
row: Fewer false whole-list conflicts in the field merge
-->

**What changed.** When one side of a merge rewrote two or more list items to read exactly like an
item it deleted, the field merge raised a conflict on the whole list. Each rewritten item now
merges as the item its key names. An item that side added as a copy beside them now stays a new
item; the merge no longer reads it as the rewritten item and drops it.
