---
'canopycms': patch
---

### A conflict in a list without item keys shows the latest version

<!-- migration
area: Branches
action: None
row: Conflicts in keyless lists show every version's value
-->

**What changed.** When the base edited an item in a list whose items carry no keys, the conflict
card couldn't find the latest version's value: it read as empty, and only editing by hand was
offered. The merge now records where each version holds the value, so the card shows all three
versions and "Use latest version" works there too.
