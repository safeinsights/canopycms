---
'canopycms': patch
---

### Saved work stays off GitHub until it is submitted — **behaviour change**

<!-- migration
area: Worker
action: None
row: Unsubmitted saved work never reaches GitHub before Submit
-->

**What changed.** When the worker brings the base branch, or commits made on GitHub, into a branch
that holds saved work its author has not submitted, the merge stays in the branch's clone: neither
the worker's own repository nor GitHub receives it until the author submits, whose push carries it.
This holds for a withdrawn branch, one sent back with "Request changes", and one whose GitHub branch
was deleted, which the worker no longer recreates with that work. Finishing an interrupted rewrite
of a published branch publishes only the rewritten history, never a commit made since.
