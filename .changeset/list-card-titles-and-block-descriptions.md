---
'canopycms': patch
---

<!-- migration
extends: legacy#field-editing-descriptions-list-card-titles-and-public-images
action: None
-->

**What changed.** A list card with no `itemTitleField`, or whose `itemTitleField` value is blank,
takes its title from its first non-blank `string` field, then "Item N" (or its `itemLabel`, as in
"Team member N"). A block template's `description` now renders; see
[List items and blocks collapse](./list-items-and-blocks-collapse.md).
