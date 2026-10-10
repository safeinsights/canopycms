---
priority: P3
adopters: BOTH
summary: >-
  A block item `{ template, value }` whose `value` is null or an array is reported by
  `findUnknownKeys` as carrying an unknown key `blocks[i].value`, so a save shows "N fields are not
  part of this entry type's schema" and a build logs the same. This happens because
  `resolveBlockItem` falls back to the item itself as the block's data when `value` is not a record,
  which is the inline `_type` shape, and `value` is not in `BLOCK_STRUCTURAL_KEYS`. The message is
  non-blocking and nothing is rewritten, but it tells an editor to delete a key that belongs to the
  canonical block shape.
---

# A null or array block `value` is reported as an unknown schema key

**Status:** Open. **Priority: P3**: a misleading warning, not data loss.

## What happens

`resolveBlockItem` (`validation/field-traversal.ts`) uses `item.value` as the block's data only
when it is a plain record. Otherwise it falls back to `item` itself, the inline `_type` shape. For a
canonical `{ template: 'hero', value: null }` the container visitor in `findUnknownKeys`
(`validation/entry-validator.ts`) then walks the item, skips `template` (a structural key) and
reports `value` as unknown, because `value` is not in `BLOCK_STRUCTURAL_KEYS`
(`validation/block-structural-keys.ts`). `api/content.ts` turns that into the save-time "not part of this entry
type's schema" notice. `static/index.ts`'s `warnUnknownEntryKeys` logs it at build time.

To reproduce, put a block whose value is `null` or `['a']` in any entry, save another field, and
read the notice.

## Shape of the fix

Pick one:

- Have `resolveBlockItem` take the inline fallback only when `item.value === undefined`, and return
  `data: {}` for a `value` that is present but not a record. Required-field validation keeps
  working, since `{}` lacks the field too. Check the callers that decide the item's shape:
  `walkFields` compares `resolved.data === item`, and `normalizeReferenceValues` tests
  `isPlainRecord(item.value)`.
- Or skip `value` in the container visitor when the record is a canonical block item.

The first removes the ambiguity at its source. Optionally add a specific validation message ("block
value must be an object").

## Same shape elsewhere

`ImageField.tsx`'s alt and crop handlers spread `value` as the base of an edit. A hand-edited
array image value would therefore be saved index-keyed. `BlockField` and `ObjectField` guard their
edit bases with `isPlainRecord`, and the same guard fits here.

A `null` block item, such as YAML `blocks: [null]` or an empty `- ` entry, reaches the editor
untouched. There `BlockField`'s `findTemplate(templates, block.template)` throws, and the field's
error boundary shows its crash fallback for the whole block list. No data is written.

## Related

- [resolved/block-value-null-or-array-breaks-resolution.md](resolved/block-value-null-or-array-breaks-resolution.md),
  the read and save crash and corruption for the same shapes. This notice is what is left after it.

[BOTH]
