---
'canopycms': patch
---

### "Add entry" follows path permissions; admin panels and labels tidied

<!-- migration
area: Editing
action: None
row: Navigator hides "Add entry" where path permissions refuse it
-->

**What changed.** The entries listing (`GET /:branch/entries`) gains `collectionAccess`, one
`canAddEntry` per listed collection, and the navigator offers "Add entry…" only where it is true.
The group and permission managers always name people, never show a raw id, confirm before their
save bar's "Discard changes", and keep Delete off the built-in groups. A read-only toggle can be
focused and announces its state. The sync-failed badge's reason opens on focus and touch. Editor
labels such as "All entries", "Manage permissions" and "Create group" are now in sentence case.
Discarding an entry's changes no longer toasts, since the form already shows it.
