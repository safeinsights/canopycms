---
'canopycms': patch
---

### The branch bar states a locked branch's status, replacing the lock banner — **behaviour change**

<!-- migration
area: Editing
action: None
row: Lock banner gone; the branch bar shows status
-->

**What changed.** The banner under the top bar is gone. A branch's lasting state now shows
once, beside the branch pill, at every width: "Loading branch…", "Protected · read-only", "In
review · read-only", "Approved · read-only", "Archived · read-only", "Details unavailable ·
read-only", or "Protected" for a protected branch that still takes edits. The pill no longer
carries a status badge, and on a phone it shows the branch name, truncated, with the full name
heading its menu. The bar offers the way forward: New branch… on the protected base branch,
Withdraw from review on a branch in review, and Switch branch… on an archived branch or when
branch details could not be loaded. Below the `md` breakpoint a locked branch has no Save all;
its way forward is the split button, with Submit or Withdraw in the caret. Someone who may not
withdraw gets Switch branch…, with the blocked Withdraw and its reason in the caret.
