---
'canopycms': patch
---

### Base changes are no longer reverted when a branch takes in its base

<!-- migration
area: Worker
action: None
row: The base merges into branches field by field
-->

**What changed.** When the base branch moves and an editing branch has changed the same entry,
the worker merges the two field by field instead of keeping the branch's whole file. Edits to
different fields, list items or body paragraphs all come in, schema changes made on the base stay,
and a field changed differently on both sides keeps the author's value and is flagged on the entry,
as before. An entry renamed on one side and edited on the other merges at the new name. A branch still
rebases where git takes the base in cleanly and the field merge agrees; any other takes the base
in with a merge commit.
