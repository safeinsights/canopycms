---
'canopycms': patch
---

### The preview toolbar holds the highlight and layout toggles, and maximizes the preview

<!-- migration
area: Preview
action: None
row: Preview toolbar: highlights, layout, maximize, unmapped marks
-->

**What changed.** The highlight toggle and the layout toggle move from the strip right of the
preview into the preview toolbar, and the strip is gone. The layout toggle is a pair of buttons,
Side by side and Stacked, with the current one pressed. Layout, preview width and highlights
persist per browser. Maximize lays the preview over the whole editing area, without reloading it,
and drafts keep reaching it. Restore or Esc brings the form back, and so does a click on a
highlighted element, which then focuses its field. Dragging the divider between preview and form
shows the preview's width over it and switches the width to Fit. Admins with highlights on see an
"N unmapped" chip when the page marks fields that don't exist in the entry. It explains what that
means and points to the browser console, which names the nearest field of each. Editors see no
such diagnostics. A custom `renderPreview` still gets no toolbar, and so no layout toggle.
