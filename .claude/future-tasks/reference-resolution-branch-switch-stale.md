# Reference Resolution: Branch Switch Without a Value Change Leaves a Field Permanently Unresolved

Discovered 2026-07-30 while writing regression tests for
`useReferenceResolution.ts`'s stale-response fix (editor-request-dedup epic).
Not part of that fix's scope — this is a distinct, pre-existing quirk in the
same hook.

## What happens

`useReferenceResolution.ts` has two effects:

1. A "clear cache on branch change" effect: `resolvedCache.current.clear()` +
   `setResolutionTrigger(prev => prev + 1)`. This correctly makes
   `resolvedValue` show `null`/loading immediately after a branch switch, so
   a stale cross-branch resolved object never flashes in the preview.
2. The debounced background-resolve effect. When it fires, it calls
   `resolveChangedReferences(prevValueRef.current, value, fields, branch,
   cache)`. `resolveChangedReferences` → `findChangedFields` compares
   `prevValueRef.current[field.name]` against `value[field.name]` by
   **value** (`JSON.stringify`), with no knowledge of `branch`.

If the branch changes but the form `value` object happens to hold the exact
same field values as before (same reference IDs — plausible if the same
entry/shape is open on both branches, or in any test that doesn't also
change `value`), `findChangedFields` sees no diff and `resolveChangedReferences`
returns `{}` — no API call, nothing added back to the cache. The debounce
effect still unconditionally calls `setResolutionTrigger` and updates
`prevValueRef.current = value` in this no-op case, so there's no error, but
the field stays showing `null`/loading indefinitely until `value` itself
changes for an unrelated reason.

In practice this is likely masked most of the time, because a branch switch
in the real editor is normally paired with an entry (re)load that produces a
genuinely new `value` object with different content — but it's not
structurally guaranteed, and is easy to hit in tests (see the assumption
that had to be walked back in `useReferenceResolution.test.ts`'s "clears the
cache when branch changes" test).

## Suggested fix

Make the debounce effect's "what changed" check branch-aware, e.g. by also
comparing `prevBranchRef.current !== branch` (treat a branch change as
"everything with a cached-eligible reference field changed") in addition to
`findChangedFields`'s value diff — or fold `branch` into what
`findChangedFields`/`resolveChangedReferences` considers when deciding what
to resolve.

## Files

- `packages/canopycms/src/editor/hooks/useReferenceResolution.ts`
- `packages/canopycms/src/editor/client-reference-resolver.ts` (`findChangedFields`, `resolveChangedReferences`)
