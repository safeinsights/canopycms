---
'canopycms': patch
---

### The Content panel lists what a branch changes — **behaviour change**

<!-- migration
area: Editing
action: None
row: Content panel filter: All, Unsaved, Changed
-->

**What changed.** The Content panel's filter now offers All, Unsaved and Changed. Unsaved is the
filter that used to be called Changed: entries with edits not yet saved. Changed lists the entries
that differ from the base branch, marked New, Edited or Moved, with deleted entries beneath the
tree, so a reviewer can see what a submitted branch changes without leaving the editor. It reads
the new `GET /:branch/changes` endpoint, which the catch-all API route already serves.
