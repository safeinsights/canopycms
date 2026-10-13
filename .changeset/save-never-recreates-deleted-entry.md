---
'canopycms': patch
---

### A save never brings back a deleted or moved entry — **behaviour change**

<!-- migration
area: Editing
action: None
row: Saving a deleted or moved entry is refused
-->

**What changed.** A save of an entry that was deleted or moved since it was opened is now refused
with a 409 (code `ENTRY_GONE`) instead of quietly re-creating it, which undid the other editor's
delete or left a second copy beside a renamed entry. The editor says the entry is gone, keeps the
changes in the form to copy out, and points to the renamed entry or "Add entry…". This also covers
an editor's own delete or rename that got no answer. Creating an entry is unchanged.
