---
'canopycms': patch
---

### "Use latest version" never changes another list item

<!-- migration
area: Branches
action: None
row: Conflict choices land only on the item the merge named
-->

**What changed.** In a list whose items look alike, a save could give one item the key of an item
you had removed. That item's conflict card then offered "Use latest version", which overwrote the
look-alike, and showed it as your version. The card now shows that item as removed, and its
latest version can't be placed: change it in the form by hand, then choose "Mark resolved".
