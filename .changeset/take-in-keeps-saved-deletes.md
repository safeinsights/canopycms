---
'canopycms': patch
---

### An entry deleted or renamed in the editor no longer comes back when GitHub's commits are taken in

<!-- migration
area: Worker
action: None
row: Saved deletes and renames survive commits from GitHub
-->

**What changed.** When a branch's copy on GitHub had commits the editor's workspace lacked, such as an Update branch or a maintainer's fix, the worker brought them in and wrote back any entry the editor had deleted, or the old path of one it had renamed, while that change was not yet submitted. The deletion was lost, or a renamed entry ended up twice. The worker now waits instead, as it already does for a saved edit to a file those commits change. An editing branch that lacks the base shows that the latest changes are waiting, and the deletion merges with GitHub's commits once it is committed, by "Get latest changes" or a submit.
