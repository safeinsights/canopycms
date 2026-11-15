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
merges as the item its key names. Where that side also copied an item it rewrote this way, the
copy now stays a new item instead of being read as the original and dropped.
