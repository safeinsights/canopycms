---
'canopycms': patch
---

<!-- migration
extends: legacy#field-editing-descriptions-list-card-titles-and-public-images
action: None
-->

**What changed.** A list card with no `itemTitleField` takes its title from its first `string`
field, then "Item N". A block template's `description` now renders; see
[List items and blocks collapse](./list-items-and-blocks-collapse.md).
