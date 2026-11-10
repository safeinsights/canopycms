---
'canopycms': minor
---

### The preview follows the form to the field you're on

<!-- migration
area: Preview
action: Optional
row: Preview scrolls to the focused field; add usePreviewReveal if hand-wired
-->

**What changed.** Focusing a field in the form, or opening its comments, scrolls the preview to the element the page marks for that field with `fieldProps`, else to the first mark inside it, else to its nearest marked ancestor, and outlines it briefly. Nothing moves when the element already shows as much as it can, focus stays in the form, focus coming back to the same field leaves the preview where you scrolled it, and reduced motion jumps instead of scrolling. It is on by default; the preview toolbar's "Scroll the preview to the field you're on" toggle turns it off, remembered per browser like the other preview controls. The editor sends a new `canopycms:preview:reveal` message, which a page accepts only from its editor, as it does the others.

**To adopt.** Nothing for a page on `useCanopyPreview` or `withCanopyPreview` once it runs this version of `canopycms/preview`. A page on an older version ignores the message, so the preview just doesn't follow. A page that wires the bridge's hooks itself adds `usePreviewReveal({ editorOrigin })` beside `usePreviewHighlight`.

**Now deletable.** Nothing.
