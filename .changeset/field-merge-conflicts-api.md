---
'canopycms': patch
---

### Submit and approve wait until conflicting changes are resolved

<!-- migration
area: Branches
action: None
row: Submit and approve refuse while merge conflicts are open
-->

**What changed.** A field that a merge from the base found changed differently on both sides stays
open until someone chooses a value. Saving the entry with that choice resolves it, and an entry
that one side deleted or that can't be merged field by field is resolved by keeping, deleting,
restoring or taking the latest version. While any conflict is open, Submit for review and Approve
answer 409 and say why. The catch-all route serves the conflicts to the editor, so adopters add
nothing.
