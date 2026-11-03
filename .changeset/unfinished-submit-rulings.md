---
'canopycms': patch
---

### A branch whose submit failed can't be approved, and a merge that may miss commits is flagged

<!-- migration
area: Branches
action: None
row: Approve blocked and merges flagged on an unfinished submit
-->

**What changed.** Approve is disabled while a branch's last submit has failed, with the reason beside it, and the API refuses it with a 409, because what's approved may not be what the pull request holds. Request changes stays open. A submit that fails after an approval sends the branch back to review and clears the verdict from the pull request. A submit that couldn't be queued counts as failed, and says to submit again.

If a pull request merges before a submit finishes, commits from that submit may not be in the merge. Archiving now records that. System health's Overview names the branch until an admin dismisses the warning or deletes the branch, the branch shows "Needs action", and only an admin can delete it meanwhile.
