---
'canopycms': patch
---

### Pull requests from the editor stay up to date with their base

<!-- migration
area: Branches
action: None
row: Editor PRs stay current with their base
-->

**What changed.** Where a repository requires branches to be up to date before merging, a pull request from the editor no longer waits behind its base for someone to click Update branch. When GitHub reports it behind, the next sync merges the base into it.

- Each update is a new commit, so required checks run again.
- An approval in CanopyCMS stays, because the pull request's changes are the same. In our test, GitHub kept an approval through a merge of the base that left the diff unchanged, under both "dismiss stale approvals" and "require approval of the most recent push". That test used a person's push under classic branch protection, so check it against your own rules.
- A pull request that conflicts with its base stays as it is. Withdraw it from review to resolve the conflict.
- Repositories that don't require up-to-date branches see no change.
