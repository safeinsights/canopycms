---
'canopycms': patch
---

### The preview toolbar holds the highlight toggle and maximizes the preview; the layout toggle moves to the rail

<!-- migration
area: Preview
action: None
row: Preview toolbar: highlights, maximize, unmapped marks; rail: layout
-->

**What changed.** The highlight toggle moves from the strip at the editor's right edge into the
preview toolbar, and the layout toggle into the rail, above Settings, so it works with any
preview or none; the strip is gone. The layout button shows the current layout and switches to
the other; while the preview is maximized it says to restore the preview first. Layout, preview
width and highlights persist per browser. Maximize lays the preview over the preview and form
area, without reloading it, and drafts keep reaching it. Restore brings the form back, and so
does Esc unless focus is inside the page. Anything that needs the form restores it too: a click
on a highlighted element, which scrolls to its field, opening the content panel over the form,
or a save refused for field errors. Dragging the divider between preview and form shows the
preview's width over it, and resizing the panes, by drag or key, switches the width to Fit.
Admins with highlights on see an "N unmapped" chip when the page marks fields that don't exist
in the entry. It explains what that means and points to the browser console, which names the
nearest field of each. Editors see no such diagnostics. A custom `renderPreview`, and an entry
with no preview page, get no toolbar.
