---
'canopycms': patch
---

### The top bar shows one unsaved mark and a status only when it matters — **behaviour change**

<!-- migration
area: Editing
action: None
row: Top bar: one unsaved dot, no "Editing" label
-->

**What changed.** The branch pill's unsaved count is the same dot as the entry's, with a number, in the brand colour the content tree also uses. "Unsaved · kept on this device" moved into Save's tooltip and description; the bar shows it only as a warning when drafts could not be stored. The pill drops the default "Editing" status and shows In review, Approved, Archived or Protected. The "Read-only" chip hides while a branch-wide lock banner is showing.
