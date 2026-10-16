---
'canopycms': patch
---

### An object's Clear moves into its "…" menu, with an inline Undo

<!-- migration
area: Editing
action: None
row: Object Clear in a "…" menu; Undo stays inline
-->

**What changed.** An optional object's Clear is now an item in a "…" menu on its label row, named
for the object ("Clear "SEO""). After a clear, the label row offers "Undo clear" in the menu's
place, with focus on it, until the object is edited, another entry opens, or the entry is saved or
discarded. It has no timer, and Clear no longer raises a toast; list item and block removals keep
theirs.
