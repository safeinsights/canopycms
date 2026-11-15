---
'canopycms': patch
---

### Update branch on GitHub no longer leaves list items under keys that name other items

<!-- migration
area: Worker
action: None
row: Items Update branch brings in get the field merge's keys
-->

**What changed.** When "Update branch" on a pull request merges the base into a branch, git keeps each list item under the key the branch's copy held, which can name another item once the base changed it. Later merges could then misread the item and undo a deletion or miss a conflict. The worker now takes such a merge in with one more commit that gives those items the keys the field merge would, and moves the branch's comment threads with them. The commit changes item keys only, so an approved branch stays approved. On GitHub it is a new push to the pull request, which dismisses approvals where the repository dismisses stale approvals.
