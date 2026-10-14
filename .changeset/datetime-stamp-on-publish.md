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
time, in the commit it pushes. A set value is never overwritten, and an entry already on the base
branch, even renamed or moved, or merged without a Canopy submit, is never stamped. The field's description
states the rule, the submit toast counts the entries dated, and after a submit that succeeds the
editor carries an unsaved draft of a stamped entry onto its stamped version.
The flag is refused off a top-level `datetime`, on `list: true`, and with `required: true`.

**To adopt.** Add `stampOnPublish: true` to the date field your site sorts or labels by, such as
`{ name: 'publishedAt', type: 'datetime', stampOnPublish: true }`. See [Stamping a publication date](../README.md#stamping-a-publication-date).

**Now deletable.** A build step or hook that writes a missing publication date into new entries.
