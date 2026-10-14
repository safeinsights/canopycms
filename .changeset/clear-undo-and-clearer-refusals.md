---
'canopycms': patch
---

### An object's Clear offers Undo, and refusals say why

<!-- migration
area: Editing
action: None
row: Clear offers Undo; refusals and conflicts explain themselves
-->

**What changed.** An optional object's Clear raises the same Undo toast as a list item's Remove,
and Undo returns focus to the object. A Remove toast says when the item's open comments moved to
"Comment on this entry". A collection your path permissions refuse new entries in says "You can't
add entries here." in place of its hidden menu. The group and permission managers show a version
conflict in yellow; the API marks it with the new error code `SETTINGS_CHANGED`.

`sanitizeHref` returns its fallback for `undefined` or `null`, which a live preview's draft can
pass for a link field it doesn't hold yet, instead of throwing.
