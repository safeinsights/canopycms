---
'canopycms': patch
---

### The base-branch conflict notice stays until the branch merges — **behaviour change**

<!-- migration
area: Branches
action: None
row: Conflict notice persists until merge
-->

**What changed.** When the CMS brings a branch up to date and keeps the branch's version of an
entry the base branch also changed, the "updated on the base branch" notice and the branch's
conflict count now stay until the branch merges, so a reviewer still sees which entries replaced a
base change. They used to clear on the next sync, about five minutes later. README's new [Drafts
and Unpublishing](../README.md#drafts-and-unpublishing) section covers long-lived branches and
unpublishing.
