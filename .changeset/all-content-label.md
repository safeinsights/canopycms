---
'canopycms': minor
---

### The editor calls the content drawer "All content"

<!-- migration
area: Editing
action: Editor UI tests
row: Breadcrumb root and file menu say "All content"
-->

**What changed.** The first breadcrumb segment and the file menu item that opens the content drawer say "All content" instead of "All entries", since the drawer holds collections as well as entries.

**To adopt.** Nothing, unless your browser tests find either by the text "All entries".
