---
'canopycms': patch
---

### Faster first request to a new editor deployment

<!-- migration
area: Ops
action: None
row: Settings workspace builds faster; cold starts share one build
-->

**What changed.** A new deployment's first request builds the settings workspace without
checking out the base branch's files, so its cost no longer grows with the size of the site, and
cold starts arriving together share that one build. If the process building it dies, the others
build their own after waiting at most 15 seconds. The `provision dir=settings` log line gives the
time each step took.
