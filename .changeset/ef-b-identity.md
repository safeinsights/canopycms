---
'canopycms': patch
---

### The editor opens the home page and names single-entry types by their type — **behaviour change**

<!-- migration
area: Editing
action: None
row: Editor opens the home page; singletons named by type
-->

**What changed.** With no entry in the URL, the editor opens the entry routed at `/`, else the first with a preview. An entry type limited to one entry (`maxItems: 1`) with a label is named by that label, though entry links and search still use its title. Content tree rows show the type on a second line, quick open shows type and route, "Rename…" is "Change URL…" ("Change file name…" for an entry with no page), and the "All content" crumb, the form header's title and the rail's site button are gone.
