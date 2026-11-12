---
'canopycms': patch
---

### Choose what to keep when you and someone else changed the same field

<!-- migration
area: Editing
action: None
row: Conflict cards in "Show changes"; Submit waits for them
-->

**What changed.** When the latest changes come into a branch and a value was changed both there
and on the branch, "Show changes" opens with a "Conflicts" group above the entry's changes. Each card
shows how the value read before, in the latest version and in yours, and offers "Use latest version",
"Keep your version" or "Edit". A value one side removed offers "Remove it" or "Keep it", and long text
gets one card per changed passage, with "Use both". A choice is saved with the entry. The entry
says how many fields need a choice, "Submit for review" waits until none do, and the "Get latest
changes" message counts them. Authors never see a branch name in this copy.
