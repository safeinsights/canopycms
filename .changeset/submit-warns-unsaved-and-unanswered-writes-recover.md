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
out, and its confirm reads "Submit anyway". After a write the server never answered: a comment
that may have been posted shows as a yellow warning; the save-outcome toasts name their entry; a
rename that landed keeps the renamed entry selected; and a collection create or details save
fills its dialog in again on the next open, until the content tree shows it landed. A lookup sent
as a POST that times out says to try again. Removing a staged entry type from a new collection
goes at once and offers Undo.
