---
'canopycms': patch
---

### One search: Mod+P opens the content panel's "Find entries" field, and the quick-open dialog is gone — **behaviour change**

<!-- migration
area: Editing
action: None
row: Mod+P opens the panel's Find entries field
-->

**What changed.** Finding an entry has one place, the content panel's field, now called "Find
entries" and showing its shortcut (⌘P on macOS, Ctrl+P elsewhere). Mod+P focuses it from
anywhere, a form field included; pressed in the field, it selects the text. With the docked panel
closed, Mod+P opens it only until Enter opens the first match, Escape is pressed in the empty
field, or focus moves elsewhere; opening a row's menu or pressing Content keeps it open. That
Enter moves focus to the opened entry's first field. The quick-open dialog, the panel's
magnifier button and the rail's Open entry button are removed; the Content button's tooltip names
the shortcut. Each tree row's second line now shows the entry's route after its type, as in
"Landing page · /contact" (the type alone when the entry has no page), in full on hover or focus
when it is cut off.
