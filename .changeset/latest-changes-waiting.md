---
'canopycms': patch
---

### "Latest changes waiting" in the branch bar

<!-- migration
area: Branches
action: None
row: Branch bar shows when latest changes wait on saved work
-->

**What changed.** The automatic sync still skips a branch with saved but uncommitted work and
commits nothing on a timer. When the base has moved on meanwhile, the branch bar now shows "Latest
changes waiting", whose tooltip points to "Get latest changes". It clears once the branch holds the
base again.
