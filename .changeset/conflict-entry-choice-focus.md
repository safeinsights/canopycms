---
'canopycms': patch
---

### Focus stays in "Show changes" after an entry-level conflict choice

<!-- migration
area: Branches
action: None
row: Entry-level conflict choices keep focus and say what happened
-->

**What changed.** After "Keep it", "Keep it deleted", "Restore entry" or "Keep your version" on a
conflict card, a status line says what happened. Focus moves to "Restore entry" while the entry
stays deleted, and otherwise to the drawer's title, instead of dropping to the page.
