---
'canopycms': minor
---

### `editor.subtitle` removed; the tab names the open entry — **breaking (`editor.subtitle` removed)**

<!-- migration
area: Editing
action: Delete editor.subtitle
row: editor.subtitle removed; browser tab names the entry
-->

**What changed.** `editor.subtitle` is no longer a config option, and `Editor` no longer takes
`subtitle` or `siteSubtitle`: nothing has shown them since the top bar replaced the old header.
While the editor is mounted, the browser tab reads "Entry label · Site title", or the site title
with no entry open, and your page's own title comes back when it unmounts.

**To adopt.** Delete `editor.subtitle` from your config; it was no longer shown.
