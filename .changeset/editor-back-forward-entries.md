---
'canopycms': patch
---

### The browser's Back and Forward move between entries in the editor — **behaviour change**

<!-- migration
area: Editing
action: None
row: Back and Forward return to entries opened before
-->

**What changed.** Opening an entry in the editor adds a browser history entry, whether it is opened from the content panel, quick open, a comment, a preview link or a new entry's creation. Back and Forward then open the entry their URL names, without reloading the page, and the preview follows; drafts are kept, as on any switch. Choosing the open entry again adds nothing, and the editor's own corrections, such as opening the home page at load or after a delete, replace the URL instead. An entry since deleted or renamed away opens the home page. A Back onto another branch switches to it, asking first when there are unsaved changes, and staying puts the URL back.
