---
'canopycms': patch
---

### The branch list shows exactly the branches you can open

<!-- migration
area: Branches
action: None
row: Branch list matches branch access
-->

**What changed.** The branch list now includes a branch only when branch access grants it, so
the two can no longer disagree. Under `defaultBranchAccess: 'allow'`, a colleague's branch with
no ACL now appears in your list, and opening it no longer shows "Not available · read-only" with
Save locked while its content loads. A branch whose explicit ACL leaves out its own creator no
longer appears in that creator's list, matching the access check that already refused them.
