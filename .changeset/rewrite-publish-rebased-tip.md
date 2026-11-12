---
'canopycms': patch
---

### A rebased branch publishes only the commits the rebase made

<!-- migration
area: Worker
action: None
row: The rewrite publish sends the rebased tip
-->

**What changed.** After rebasing a submitted branch onto the base, the worker publishes the rewritten history to the workspace's remote and GitHub. It read the branch's head for that a few steps after the rebase. If the worker had lost its lock and the editor committed saved work in that moment, that unsubmitted work was published too. The worker now publishes the commit the rebase made, and saved work committed after it stays unpublished until it is submitted.
