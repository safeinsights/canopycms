---
'canopycms': patch
---

### A left activity rail and a docked content panel

<!-- migration
area: Editing
action: None
row: Left rail opens content, search, branches, comments, media
-->

**What changed.** A rail down the editor's left edge opens the content panel, quick open, the
Branches and Comments drawers and the media library, with Settings and the account control at its
foot. Comments open from the rail only, with the unresolved count on the button, and the media
library has its own button instead of a Settings menu item. In a wide side-by-side window the
content panel docks beside the preview and stays open as you move between entries. Its width and
whether it is open survive a reload. Narrower than 1024px, or stacked, it lays over the form
only, so the preview stays in view. Below 1024px the editor also starts stacked until you choose
a layout. Notifications moved to the bottom-right corner, opposite the rail.
