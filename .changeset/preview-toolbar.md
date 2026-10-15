---
'canopycms': patch
---

### The preview has a toolbar with device widths, reload and the saved version

<!-- migration
area: Preview
action: None
row: Preview toolbar: path, device width, reload, saved version
-->

**What changed.** A toolbar above the editor's preview shows the page's path on your site
(without `editor.previewPrefix` or `?branch=`), which copies on click. Its width selector
renders the page at Fit, Desktop (1280 px), Tablet (768 px) or Mobile (390 px): the iframe takes
exactly that CSS width, so your site's own breakpoints apply, scaled down when the pane is
narrower. The choice persists per browser. Reload reloads the preview, the same action as the
"Live updates off" Retry. "Open saved version" opens the page's `?branch=` URL in a new tab,
which shows the branch's last saved state, without unsaved edits. A preview error now sits
between the toolbar and the page instead of over it, naming the field by its labels. A custom
`renderPreview` gets no toolbar. `PreviewFrame` takes two new optional props, `iframeStyle` and
`onReload`.
