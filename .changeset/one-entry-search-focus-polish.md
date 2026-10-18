---
'canopycms': patch
---

<!-- migration
area: Editing
action: None
row: Find entries focus ring, tooltip and hint polish
extends: one-entry-search
-->

**What changed.** The form pane, when it takes focus after Enter opens an entry with no fields, draws the
editor's focus ring inside its edges, above the form's sticky header. On keyboard focus, a tree
row's cut-off line shows in full after the same delay as on hover, below the row (above it when
there is no room), never over the row's title, and Escape hides it. The field's shortcut hint takes
the placeholder's colour, and its clear buttons read "Clear search".
