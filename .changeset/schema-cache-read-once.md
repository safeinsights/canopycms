---
'canopycms': patch
---

### Content reads stop re-reading and re-parsing the schema cache

<!-- migration
area: Reading
action: None
row: Faster content reads; smaller schema cache file
-->

**What changed.** An adopter's request measured every `read()` and `readByUrlPath()` reading and parsing the branch's whole schema cache file, up to five times per page. Each process now keeps the schema it parsed and reuses it while the file is unchanged, still checking its freshness on every read. `readByUrlPath()` resolves the branch's schema once for both of the paths it tries. A build resolves the schema once per process instead of on every read. The cache file is written without indentation, under half its former size.
