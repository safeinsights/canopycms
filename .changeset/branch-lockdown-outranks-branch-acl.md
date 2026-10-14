---
'canopycms': patch
---

### A branch lockdown outranks the branch's access list — **security fix**

<!-- migration
area: Branches
action: Optional
row: managerOrAdminAllowed now refuses editors an access list names
-->

**What changed.** A branch whose `access.managerOrAdminAllowed` is `true` admits only admins and
reviewers, whatever its `allowedUsers` and `allowedGroups` list. An access list used to switch the
lockdown off, so a listed editor, or a creator who listed themselves, could read, edit, comment
on, submit and withdraw a locked branch. The branch list hides a locked branch from editors, and
the editor's Submit and Withdraw controls follow the same rule.

**To adopt.** Nothing, unless a site relied on an access list admitting editors to a locked
branch: those editors lose access. To give it back, set `managerOrAdminAllowed` to `false` in
that branch's `branch.json`, and the access list decides again.
