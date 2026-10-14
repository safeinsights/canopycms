---
'canopycms': minor
---

### `stampOnPublish` dates a new entry at its first submit

<!-- migration
area: Schema
action: Optional
row: Date new entries at their first submit
-->

**What changed.** A top-level `datetime` field can set `stampOnPublish: true`. When Canopy first
submits an entry the base branch does not have, it fills that field, if empty, with the submit's
time, in the commit it pushes. A set value is never overwritten, and renamed, moved or plain-git
entries are never stamped. The editor shows "Set automatically when submitted" while it is empty.
The flag is refused off a top-level `datetime`, on `list: true`, and with `required: true`.

**To adopt.** Add `stampOnPublish: true` to the date field your site sorts or labels by, such as
`{ name: 'publishedAt', type: 'datetime', stampOnPublish: true }`.

**Now deletable.** A build step or hook that writes a missing publication date into new entries.
