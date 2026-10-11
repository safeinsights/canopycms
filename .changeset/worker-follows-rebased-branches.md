---
'canopycms': patch
---

### The worker follows a rebased or deleted GitHub branch

<!-- migration
area: Worker
action: None
row: Worker follows a rebased or deleted branch
-->

**What changed.** When a branch is rebased and force-pushed on GitHub, or deleted there, the
worker updates or deletes its own copy of it instead of warning about it on every sync. A rebased
branch's copy that holds editor work is left as it is: the worker warns once, and System health
lists it with what to do.

**To adopt.** Nothing.
