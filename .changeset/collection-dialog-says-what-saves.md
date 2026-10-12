---
'canopycms': minor
---

### The collection dialog says what saves at once

<!-- migration
area: Editing
action: Editor UI tests
row: Collection dialog says what saves at once
-->

**What changed.** Editing a collection, entry-type changes still save to the branch at once, and
the dialog now says so; name, label and slug save from "Save collection details". The dismiss
button reads "Discard changes", "Close" or "Cancel" to match what it does. Entry-type results show
inline instead of as toasts.

**To adopt.** Nothing, unless browser tests click the old buttons or wait for those toasts.
