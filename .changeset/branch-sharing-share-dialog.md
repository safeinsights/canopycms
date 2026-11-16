---
'canopycms': patch
---

### Share a branch from its card

<!-- migration
area: Editing
action: None
row: The Share dialog, from a branch card
-->

**What changed.** A branch card's "…" menu offers "Share…" to anyone who may add people to the branch, and its "Access" line is now a button. Both open the Share dialog: find people by name or exact email address, add groups you belong to, remove people with Undo, and send every change at once with "Update access". Owners and admins also choose who can add people and, where branches are open by default, whether only listed people may open this one. Anyone else who may open the branch gets a read-only "Who has access" list. A save refused because the branch is no longer open to you now says so, and points to "Branches". A refused change to the list names the people it concerns (`ids`), never one found only by an address; the exclusion cap and a list changed meanwhile get their own codes, `EXCLUSION_CAP` and `LIST_CHANGED`; and an owner or admin can allow back by id someone removed, even from outside this CMS.
