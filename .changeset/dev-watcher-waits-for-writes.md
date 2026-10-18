---
'canopycms': patch
---

### The dev content watcher waits for a save to finish before comparing

<!-- migration
area: Ops
action: None
row: Dev content watcher ignores half-written saves
-->

**What changed.** In `dev` mode, the watcher that warns when working-tree content has diverged from the served branch clone now acts on a new or changed file only once its size has held still for 100 ms. A save that truncates and then writes could reach the watcher as one event between the two steps. The check then read a half-written file and warned of a divergence that nothing later retracted. Now any warning about a half-finished save is retracted once the save completes.
