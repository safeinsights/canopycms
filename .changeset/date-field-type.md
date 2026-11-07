---
'canopycms': minor
---

### A `date` field for a day with no time and no zone

<!-- migration
area: Schema
action: Optional
row: New `date` field type holds a day, no zone
-->

**What changed.** A new scalar field type, `date`, holds a calendar day as a `YYYY-MM-DD` string, edited with a day picker. `datetime` stores an instant, so a day picked in one zone can read as the day before in another; a `date` is the same day everywhere. A save and a production build refuse a value that is not a real day, such as `2026-02-30` or `2026-5-1`; YAML rolls an unquoted `2026-02-30` forward first, so quote hand-written days. A hand-written unquoted `2024-05-01` in md or mdx frontmatter reads as that day in every zone, and survives a save on its own line. `list: true` is refused on a `date`; use an object list with a `date` field inside, which `itemTitleField` may name. `stampOnPublish` stays on `datetime`, and `datetime` values and checks are unchanged. Editor field errors now meet 4.5:1 contrast.

**To adopt.** Change `type: 'string'` to `type: 'date'` on a field that holds `YYYY-MM-DD`: `TypeFromEntrySchema` still gives `string`, and every `YYYY-MM-DD` value stays as it is. A production build lists any entry whose value is not a real day, such as `2026-5-1`; fix those by hand. A custom field type that was named `date` keeps its `customRenderers` entry but is now checked as a `date`, so rename it if its values differ. See [Field Types](README.md#field-types).

**Now deletable.** A `string` field with a hand-written `YYYY-MM-DD` format check, and site code that reads a `datetime` back into a day.
