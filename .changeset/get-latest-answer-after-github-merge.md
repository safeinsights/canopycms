---
'canopycms': patch
---

### "Get latest changes" reports the conflicts a merge of GitHub's commits leaves

<!-- migration
area: Worker
action: None
row: Get latest changes answers after a merge of GitHub's commits
-->

**What changed.** When the latest changes reached a branch through its pull request on GitHub, for example after Update branch, "Get latest changes" merged them, then answered "You already have the latest changes" a cycle later, even where the merge left values for a person to choose. It now answers as a merge of the base does, with the conflicts to resolve, and the "Latest changes waiting" badge clears at once.
