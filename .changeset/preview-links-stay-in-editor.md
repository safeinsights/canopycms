---
'canopycms': patch
---

### Links clicked in the preview open their entry instead of leaving the editor — **behaviour change**

<!-- migration
area: Preview
action: None
row: Preview links open their entry; others open a new tab
-->

**What changed.** A plain click on a link in the editor's preview no longer navigates the frame off its preview route to a public page, which could refuse to be framed. A link to another page of the site opens that page's entry in the editor, keeping the draft of the one left; a page no entry has, such as a listing, opens in a new tab with a note saying so; a link to another site opens in a new tab. Cmd/Ctrl/Shift/Alt and middle clicks, links with a `target` or `download`, same-page `#` links and `mailto:`/`tel:` links behave as they do outside the editor, and a click that follows a link no longer also focuses the field it sits in. Pages using `useCanopyPreview` or `withCanopyPreview` get this with no change.
