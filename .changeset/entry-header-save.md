---
'canopycms': patch
---

### Save moves into a header over the open entry, and Save all becomes its own button — **behaviour change**

<!-- migration
area: Editing
action: None
row: Save beside the entry; Save all its own button
-->

**What changed.** A header above the preview and form holds the open entry's breadcrumb, entry
menu, unsaved dot, "Read-only" chip and Save. It stays in view while the preview is maximized,
and with no entry open Save stays there, blocked, saying to open one; while entries load, the
crumb is a placeholder. "Save all" leaves Save's
menu for a button of its own in the top bar, showing the unsaved count and then its progress,
and waits while any entry is saving. Save waits while Save all runs, and says why. The warning
that drafts could not be stored on this device now shows whenever anything on the branch is
unsaved, not only the open entry.
