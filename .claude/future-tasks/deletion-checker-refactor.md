# DeletionChecker: Use traverseFields Instead of Manual Traversal

## Problem

`DeletionChecker.findIdInData` (`validation/deletion-checker.ts`) has its own duplicated field traversal loop, mirroring the logic in `validation/field-traversal.ts`. This duplication has caused bugs in the past: when `traverseFields` was fixed to handle `list:true` object fields (April 2026), the equivalent fix had to be manually applied to `findIdInData` as a follow-up after a sub-review caught the omission.

Any future change to the traversal logic (new field types, new edge cases) will need to be applied in two places.

## Proposed Fix

Refactor `DeletionChecker.findIdInData` to use `traverseFields` from `field-traversal.ts`:

```ts
import { traverseFields } from './field-traversal'

private findIdInData(
  data: Record<string, unknown>,
  targetId: string,
  fields: FieldConfig[],
  pathPrefix = '',
): string[] {
  return traverseFields(fields, data, ({ field, value, path }) => {
    if (field.type !== 'reference') return []
    const ids = Array.isArray(value) ? value : [value]
    return ids.includes(targetId) ? [path] : []
  }, pathPrefix)
}
```

This eliminates the duplicated traversal logic entirely, reduces the function to ~10 lines, and ensures future field-traversal fixes automatically apply to deletion checking.

## Notes

- The visitor approach matches the pattern `traverseFields` was designed for
- `DeletionChecker` is the only remaining consumer of a hand-rolled traversal in `validation/`
- `ReferenceValidator` and `EntryLinkValidator` already use `traverseFields`

## Also: reconcile `_type` vs `template` block discriminator

`ai/json-to-markdown.ts:376` uses `blockItem._type || blockItem.template` as the block type
discriminator, suggesting `template` is a legitimate alternate key in some content. Both
`traverseFields` (`field-traversal.ts:36`) and `findIdInData` (`deletion-checker.ts`) use only
`_type`, so blocks stored with `template` are silently skipped during reference validation and
deletion checking.

Reconcile this at the same time as the refactor: decide on the canonical key and make all
traversal code consistent.

## Files

- `packages/canopycms/src/validation/deletion-checker.ts`
- `packages/canopycms/src/validation/field-traversal.ts`
- `packages/canopycms/src/ai/json-to-markdown.ts` (for context on the `template` key)
