---
'canopycms': patch
---

### A branch in review takes in its base when no field clashes

<!-- migration
area: Worker
action: None
row: Branches in review merge the base field by field
-->

**What changed.** When GitHub reports that a submitted or approved branch's pull request conflicts
with its base, the worker now merges the base in field by field instead of holding the branch. A
submitted branch stays submitted. An approved branch returns to review, since the merge settled
what git could not and no reviewer has seen that. A field changed differently on both sides, or
anything else a person must decide, still holds the branch with "Needs action", and its author
withdraws it to choose, as before.
