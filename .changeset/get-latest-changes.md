---
'canopycms': patch
---

### "Get latest changes" brings the base branch into an editing branch on request

<!-- migration
area: Branches
action: None
row: Editors pull in the base branch's changes on demand
-->

**What changed.** An editing branch's bar and card offer "Get latest changes" (prod). It commits
the branch's saved work locally, then asks the worker to bring the base branch in at once instead
of at its next sync. The form is read-only while the worker works, for up to two minutes, and a
toast reports the result. Withdrawing the open branch from review when it conflicts with its base gets
the latest changes too. A worker that archives a merged pull request also syncs the other branches
soon after. Dev mode runs no worker, so it doesn't offer the button.

**Deploy order.** Deploy the worker before the CMS image. An older worker fails the new
`sync-branch` task, and the request is then answered only by its next regular sync.
