---
'canopycms': minor
---

### An object's Clear moves into its "…" menu, with an inline Undo

<!-- migration
area: Editing
action: Editor UI tests
row: Object Clear in a "…" menu; Undo stays inline
-->

**What changed.** An optional object's Clear is now an item in a "…" menu on its label row, named
for the object ("Clear "SEO""). After a clear, the label row offers "Undo clear" in the menu's
place, with focus on it, until the object is filled in again, another item takes the place of a
list item or block holding it, another entry or branch opens, or the entry is saved or its draft
discarded. It has no timer, and Clear no longer raises a toast; list item and block removals keep
theirs. Their Undo, and the inline one, now survive edits to other items in an enclosing list.

**To adopt.** A UI test that clicked an object's "Clear" button now opens the object's
"Actions for …" menu and chooses the "Clear" item, then finds "Undo clear" in the label row instead of a toast.
