---
'canopycms': patch
---

### A damaged conflict record holds its branch until an admin releases it

<!-- migration
area: Branches
action: None
row: A damaged conflict record holds the branch for an admin
-->

**What changed.** When a branch's record of conflicting changes can't be read, the worker sets it
aside and the branch waits: Submit for review and Approve refuse, rather than going ahead as if
nothing needed a choice. An admin sees "Needs action" in the branch bar with "Release hold", whose
confirm says which choices are lost; a later merge from the base also releases it. A record written
in another format is left as it is: Submit and Approve refuse until a developer deals with it.
