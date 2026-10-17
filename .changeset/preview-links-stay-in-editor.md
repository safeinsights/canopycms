---
'canopycms': patch
---

### Links clicked in the preview open their entry instead of leaving the editor — **behaviour change**

<!-- migration
area: Preview
action: None
row: Preview links open their entry; others open a new tab
-->

**What changed.** A plain click on a link in the editor's preview no longer navigates the frame off its preview route to a public page, which could refuse to be framed. A link to another page of the site opens that page's entry in the editor, keeping the draft of the one left, and focus follows into its page. A page no entry has, such as a listing, opens in a new tab, and a note naming it says so; a link to another site opens in a new tab. Cmd/Ctrl/Shift/Alt and middle clicks, links with a `target` or `download`, links to the same page and `mailto:`/`tel:` links behave as they do outside the editor. A click that follows a link no longer also focuses the field it sits in, except while fields are highlighted, when a click on a marked link picks its field instead. The preview takes over links only once the editor has connected, so a public page embedded elsewhere keeps its links. Pages using `useCanopyPreview` or `withCanopyPreview` get this with no change.
