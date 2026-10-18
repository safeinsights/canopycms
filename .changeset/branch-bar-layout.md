---
'canopycms': patch
---

### The top bar becomes the branch bar — **behaviour change**

<!-- migration
area: Editing
action: None
row: Branch pill first; narrow editable branches get a split button
-->

**What changed.** The branch pill moves to the start of the top bar, and its menu opens from
there. The actions on the branch sit at the bar's other end: the warning that drafts could not
be stored on this device, then Save all, then Submit for review or Withdraw from review. Below
the `md` breakpoint, on a branch you can edit, Save all and the review action share one split
button: Save all is the button, and its caret holds Submit or Withdraw. A branch with no review
action draws no caret. The confirm dialog returns focus to the review action, and focus follows
that action when a submit or withdraw moves it between the caret and a button of its own.
