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
repository. The worker now checks that each prerequisite of the bundle is a commit and indexes
the pack itself, so the sync skips only the damaged branch, as it did on git 2.55. Three kinds of
damage still stop every fetch, as they did on 2.55: a corrupt object in `remote.git` that the
incoming pack also carries, a prerequisite whose object header is torn, and a corrupt object on
the walk that picks what to fetch, before the first fetch has written its tracking refs
([#1104](https://github.com/safeinsights/canopycms/issues/1104)).
