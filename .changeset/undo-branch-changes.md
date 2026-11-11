---
'canopycms': minor
---

### Undo a branch's saved changes from "Show changes"

<!-- migration
area: Editing
action: None
row: Undo saved changes, or restore deleted entries, from "Show changes"
-->

**What changed.** The "Show changes" drawer can now set saved changes back to the base branch. Each changed field, list item or block has "Undo change", and the entry has "Undo all changes". An undo is an unsaved edit in the form: "Redo change" or "Discard changes" reverses it, and Save keeps it. A change the form has edited since can't be undone or redone until that edit is saved or discarded, so no edit is lost. List and block items are matched by item key, so a removed item comes back in its old place with its comment threads, and an item the branch added goes, its threads moving to the entry as a Remove does. An entry added on the branch offers "Delete entry", and one deleted on it "Restore entry", which puts the base's file back with its content id, so references and comment threads find it again. It puts the entry back in its collection's manual order, and refuses while another entry holds the URL, past the type's `maxItems`, or when the type's format has changed since. The controls follow the form's rules: disabled with the lock's reason on a branch in review, approved or otherwise read-only, and hidden without edit access. An entry type change can't be undone here, and undo leaves a moved entry where it is.
