---
'canopycms': patch
---

### A refused "Get latest changes" that is a conflict shows yellow

<!-- migration
area: Branches
action: None
row: "Get latest changes" conflicts show yellow, not red
-->

**What changed.** When "Get latest changes" is refused because of the branch's state, for example
a branch in review or one busy with a save, the message now shows yellow, as other conflicts do.
Other failures stay red.
