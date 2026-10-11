---
'canopycms': patch
---

### The worker moves objects between GitHub and `remote.git` as bundles

<!-- migration
area: Worker
action: None
row: GitHub objects cross as bundles
-->

**What changed.** The worker, run as one process, moves objects between GitHub and `remote.git`
as git bundles. A new instance's first sync fetches the whole repository from GitHub, and
operations may reuse GitHub fetches under 30 seconds old.

**To adopt.** Nothing. Seeding `remote.git` stages a copy of the repository in the state
directory.
