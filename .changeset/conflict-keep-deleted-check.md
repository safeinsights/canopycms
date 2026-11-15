---
'canopycms': patch
---

### "Keep it deleted" on a conflict checks that the entry is still gone

<!-- migration
area: Branches
action: None
row: "Keep it deleted" refused once the entry is back
-->

**What changed.** If an entry came back after "Show changes" opened (from another tab, or a
restore whose answer was lost), "Keep it deleted" no longer clears its conflicts. The card reloads
and shows what is left to choose.
