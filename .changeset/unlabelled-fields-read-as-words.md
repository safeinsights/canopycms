---
'canopycms': minor
---

### Unlabelled fields and block templates show their names as words

<!-- migration
area: Editing
action: Editor UI tests
row: Unlabelled field names are humanised
-->

**What changed.** A field, group or block template with no `label` shows its name in sentence case,
`metaText` as "Meta text", in its form label, the outline, comment and validation breadcrumbs, the
block picker and the Remove toast.

**To adopt.** Nothing, unless your browser tests find such a field by its raw name. Give it a
`label` to choose the words yourself.
