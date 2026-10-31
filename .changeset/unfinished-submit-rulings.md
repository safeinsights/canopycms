---
'canopycms': patch
---

### A branch whose submit never finished can't be approved, and can't merge unnoticed

<!-- migration
area: Branches
action: None
row: Approve blocked on an unfinished submit; merged branches flagged to admins
-->

**What changed.** Approve is disabled while a branch's last submit is unfinished, with the reason beside it, and the API refuses it with a 409, because what's approved may not be what the pull request holds. Request changes stays open.

If a pull request merges before a submit finishes, commits from that submit may not be in the merge. Archiving now records that. System health's Overview names the branch until an admin dismisses the warning or deletes the branch, the branch shows "Needs action", and only an admin can delete it meanwhile.
