---
'canopycms': minor
---

### The editor takes over the window — **breaking (`EditorPanes` export removed)**

<!-- migration
area: Editing
action: EditorPanes importers only
row: Editor fills the window over the host layout; EditorPanes removed
-->

**What changed.** The editor renders as one full-window layer above your page, so a header or
footer your root layout renders no longer pushes it down or makes the page scroll. While it is
mounted, its sign-in and loading screens included, your layout's elements are hidden and out of
the Tab order, and the page does not scroll; unmount restores them. The footer is gone: the version and an "About CanopyCMS" link are
in the Settings menu. The two read-only banners sit in their own row under the header. The
preview/form divider is now keyboard-resizable within the same 15–85% the split was always
stored at, and `react-split-pane` is no longer a dependency.
`EditorPanes`, `EditorPanesProps`, the `PaneLayout` type and the `SPLIT_PERCENT_*` and `DEFAULT_*_SPLIT_PERCENT` constants are
no longer exported from `canopycms/client`. See
[Your root layout](../README.md#editor-customization).

**To adopt.** Nothing, unless you import `EditorPanes` or those constants: render `CanopyEditor`
instead, which lays out its own panes. Hiding your site chrome on the editor route is now
optional, but keeping analytics and global fetches out of it is still worthwhile.

**Now deletable.** A wrapper that drops the site header and footer on the editor route only to
stop them shifting the editor.
