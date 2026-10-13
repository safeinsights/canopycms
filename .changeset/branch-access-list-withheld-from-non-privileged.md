---
'canopycms': patch
---

### Branch access lists stay with admins and reviewers — **behaviour change**

<!-- migration
area: Branches
action: None
row: Non-privileged callers get only their own branch ACL entries
-->

**What changed.** Every branch response (the listing, create, the workflow actions, status and
access updates) sends a caller who is not an admin or reviewer only the `access.allowedUsers` and
`access.allowedGroups` entries naming them or their groups, and counts the rest in a new
`withheldAccess` field. A branch card's access list shows the people the viewer can name, then
"and N others", instead of a row of "Name unavailable" avatars.
