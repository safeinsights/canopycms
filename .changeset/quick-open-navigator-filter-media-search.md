---
'canopycms': minor
---

### Quick open, a navigator filter, title-first new entries, and media search

<!-- migration
area: Editing
action: Editor UI tests
row: Quick open, navigator filter, title-first entries, media search
-->

**What changed.** Ctrl+P (⌘P on macOS) opens a quick-open list of entries from anywhere in the
editor, even inside a text field, unless another dialog is open (the Content drawer gives way to
it), so the browser's print shortcut never prints while the editor
is open. The navigator filters by title or slug. "Add entry" asks for the title first, when the
entry type has a title field, and derives the slug from it until the slug is edited. The media
library searches, sorts and filters all its files, in a grid or a list.

**To adopt.** Nothing, unless browser tests add an entry by typing only a slug: fill in "Title"
too when the entry type has one.
