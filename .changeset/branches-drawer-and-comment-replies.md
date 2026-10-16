---
'canopycms': minor
---

### The Branches drawer shows one action per branch, and comments reply in place

<!-- migration
area: Editing
action: Editor UI tests
row: Branches drawer and comment replies
-->

**What changed.** The drawer lists the open branch first, with one action per card and the rest
in a "…" menu, in the editor's vocabulary. A thread's Reply opens a box under it.

**To adopt.** Nothing, unless your browser tests click the old drawer buttons or labels. Every
form has a "Field comments" button, so tests that find buttons by `/comment/i` may match more than
one; and the editor listens for Ctrl+Alt+M (⌘⌥M on macOS) on the whole document, taking it while a
form is open.
