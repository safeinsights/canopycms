---
'canopycms': patch
---

### Show changes on a changed entry

<!-- migration
area: Editing
action: None
row: Show changes compares an entry with the base branch
-->

**What changed.** Reviewers and editors can open "Show changes" on a changed entry to see each
changed field's old and new values against the base branch, with text differences highlighted.
It opens from the entry header, and from each entry the Content panel's Changed filter lists as
deleted. It reads the new `GET /:branch/changes/...entryPath` endpoint, which the catch-all API
route already serves.
