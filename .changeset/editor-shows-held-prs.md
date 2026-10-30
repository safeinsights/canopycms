---
'canopycms': patch
---

### The branch list says when a pull request is stuck, and what to do

<!-- migration
area: Branches
action: None
row: Branch list shows held pull requests
-->

**What changed.** A branch in review could sit behind its base with nothing in the editor to say why. The branch card now shows a "Held" badge and a line saying what's wrong and what to do, and System health shows the same.

- A branch that conflicts with its base: withdraw it from review to resolve the conflict.
- A pull request retargeted to another base on GitHub: use Update branch on GitHub.
- A branch force-pushed on GitHub: a developer needs to fix it, and System health says how.
- A branch in review with a failed sync now says it won't update from its base until the sync is fixed.
