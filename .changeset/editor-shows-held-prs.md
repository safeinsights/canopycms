---
'canopycms': patch
---

### The editor says when a pull request is stuck, and what to do

<!-- migration
area: Branches
action: None
row: Editor shows held pull requests
-->

**What changed.** A branch could sit stuck with nothing in the editor to say why. The branch bar and the branch card now show a "Needs action" badge, with what's wrong and what this person can do about it, and System health shows the same.

- A branch in review that conflicts with its base: the line gives its author, a reviewer and anyone else their own way forward.
- A pull request retargeted to another base on GitHub: update it on the pull request, or ask an admin.
- A branch force-pushed on GitHub: submit is blocked, as nothing can reach GitHub until an admin sorts it out.
- A branch in review with a failed sync now says it won't update from its base until it syncs.
