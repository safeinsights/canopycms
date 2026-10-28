---
'canopycms': patch
---

### The worker keeps syncing past one corrupt branch on git 2.56 and later

<!-- migration
area: Worker
action: None
row: One corrupt branch no longer stops every sync
-->

**What changed.** From git 2.56, `git bundle unbundle` fails when any branch in `remote.git` has a
corrupt object in its history. Because the worker used it for every GitHub fetch, one torn
object on the shared filesystem would have failed every sync cycle until an operator repaired the
repository. The worker now checks that each prerequisite of the bundle is present and indexes
the pack itself, so only the damaged branch is skipped, as on older git. Workers on Amazon Linux
2023's current git (2.50) were not yet affected.
