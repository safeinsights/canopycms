---
'canopycms': patch
---

### A branch you can't open says so everywhere, and locked drafts say why they wait

<!-- migration
area: Editing
action: None
row: No-access empty states; locked-branch unsaved tooltip
-->

**What changed.** On a branch the branch list doesn't include for you ("Not available ·
read-only" in the bar), the content panel and the form pane now say "You don't have access to
this branch." and offer Switch branch…, which opens Branches; the preview pane says the same.
Before, they read "No content" and "Select an item to start editing.", and a red toast showed the
server's raw refusal. That refusal is no longer toasted. Any other failed content load keeps its
"Could not load content" toast with Retry, now in plain words, with the server's message behind
a "Details" disclosure. On a locked branch, the bar's "N unsaved" tooltip says the edits are in
this browser and what lets them be saved: "Withdraw to save them." in review or approved,
"Refresh the branch to save them." when details failed to load, and on a protected or archived
branch that they can only be discarded.
