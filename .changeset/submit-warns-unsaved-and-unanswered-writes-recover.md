---
'canopycms': patch
---

### Submit names unsaved entries; unanswered writes recover more

<!-- migration
area: Editing
action: None
row: Submit warns about unsaved entries; unanswered writes keep input
-->

**What changed.** Submitting a branch with unsaved edits names the entries the submit leaves
out, and its confirm reads "Submit anyway". After a write the server never answered, the editor
re-reads what it touched: a comment the reload shows counts as posted, otherwise it is a yellow
warning; a rename the re-list shows under its new name keeps that entry selected, otherwise the
rename dialog warns in yellow; and a collection create or details save fills its dialog in again
on the next open, unless a fresh read then shows it landed (a create only once a read rules it
out). The save-outcome toasts name their
entry. A lookup sent as a POST that times out says to try again. Removing a staged entry type
from a new collection goes at once, with Undo in the dialog.
