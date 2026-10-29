---
'canopycms': patch
---

### Live preview shows a list reference's picks on load

<!-- migration
area: Preview
action: None
row: List-reference picks preview on load, not null
-->

**What changed.** The editor loads an entry with its references resolved, so a `list: true`
reference arrives as its targets. Live preview used to hand the view `null` for each of them until
the list was edited; it now passes each loaded target through, as it already did for a single
reference.
