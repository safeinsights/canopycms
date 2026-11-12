---
'canopycms': minor
---

### "Get latest changes" works in dev mode

<!-- migration
area: Branches
action: None
row: Dev mode offers "Get latest changes"
-->

**What changed.** In dev mode, "Get latest changes" now shows on an editing branch. The request
runs the worker's merge for that branch alone and answers before it returns, so the result and
any conflicts show at once. It brings in the local remote's base; a branch cloned from another
remote is told so and left as it is. Prod still queues the request for the CMS worker, as before.
