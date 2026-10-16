---
summary: >-
  RESOLVED 2026-10-09, branch `fix/guard-referenced-delete`, base `int-202610-b` (stacked on `chore/backlog-frontmatter`). The hand-rolled `findIdInData` and the `DeletionChecker` class are gone. Reference ids are collected by `collectReferenceIds` (`validation/field-traversal.ts`), built on `traverseFields`, so block, object-list and group shapes are the validator's. The scan is the pure `findReferencingEntries` (`validation/deletion-checker.ts`) over raw `listEntries` items, read per entry by that entry's own type schema. The old class also compared ids against reference-RESOLVED data and used one schema per collection, so it could not have found a reference through a real store. Shipped with [delete-referenced-entry-unguarded.md](delete-referenced-entry-unguarded.md).
---
# DeletionChecker: Use traverseFields Instead of Manual Traversal

**Status: RESOLVED 2026-10-09**, with the delete guard in
[delete-referenced-entry-unguarded.md](delete-referenced-entry-unguarded.md). The text below is
the original task.

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

## ~~Also: reconcile `_type` vs `template` block discriminator~~ — RESOLVED

**RESOLVED by PR #88 (`7d20cbfa`)**, verified 2026-08-13. A shared
`resolveBlockItem()` now lives at `field-traversal.ts:60-81` and is called by
**both** `traverseFields` (`:171`) and `deletion-checker.ts`'s `findIdInData`
(`:192`), checking `template` first with an `_type` fallback, consistently in
both places. `ai/json-to-markdown.ts:544` is a third independent call site whose
own comment acknowledges both keys are legitimate — consistent with, not
contradicting, the resolved behaviour.

Only the primary ask below remains: route `findIdInData` through `traverseFields`
itself. That duplication is real today — `deletion-checker.ts:120-210` is still a
hand-rolled recursive traversal structurally parallel to `traverseFields`
(`field-traversal.ts:110-189`).

Historical text follows.

### Original finding

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
