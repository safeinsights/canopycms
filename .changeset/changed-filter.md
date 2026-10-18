---
'canopycms': patch
---

### The content panel lists unsaved entries under a Changed filter, replacing the pill's list — **behaviour change**

<!-- migration
area: Editing
action: None
row: Unsaved entries listed under the panel's Changed filter
-->

**What changed.** The branch pill's menu no longer lists the unsaved entries. It keeps Switch
branch…, Refresh branch and Discard all changes. The unsaved count leaves the pill, and Save all
no longer carries it: "N unsaved" beside the branch's status opens the content panel filtered to
Changed, with any search cleared, in the overlay on a narrow window. The panel's All / Changed
choice lists only entries with unsaved changes, under the collections that hold them, and
combines with the search field. Enter opens the first one. Changed says when nothing is unsaved,
when no unsaved entry matches the search, when some entries are still being listed, and when the
entry list failed to load; an unsaved entry outside the content tree is offered beneath it.
Finding an entry with Mod+P, or switching branch, goes back to All. The entry menu gains "Show
in content panel": it opens the panel on All, with the search cleared, and focuses the entry's
row.
