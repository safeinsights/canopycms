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
delete or left a second copy beside a renamed entry. For a renamed entry the editor opens it under
its new name with the changes still in the form, ready to save again. For a deleted one it keeps
the changes and offers "Save as new entry", a deliberate create. This also covers an editor's own
delete or rename that got no answer. Creating an entry is unchanged.
