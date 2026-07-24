# README's `isPermissionError` example never fires for a `canopy.read()` denial

**Status**: proposed
**Priority**: P3 (doc/code mismatch — the example silently doesn't do what it says)
**Origin**: surfaced while implementing level-scoped `defaultPathAccess` and the
`readByUrlPath` FORBIDDEN-to-null change (2026-07-24, server-mode-500-errors branch).
Read `README.md`'s Error Handling Utilities section alongside
`packages/canopycms/src/utils/error.ts` and `packages/canopycms/src/content-store.ts`.

## Symptom

`README.md`'s "Error Handling Utilities" section (~lines 1569-1599) recommends this
pattern for a direct `canopy.read()` call:

```typescript
import { isNotFoundError, isPermissionError } from 'canopycms/utils/error'

try {
  const { data } = await canopy.read({ entryPath: 'content/posts', slug })
  return <PostView post={data} />
} catch (err) {
  if (isNotFoundError(err)) return notFound()
  if (isPermissionError(err)) return <Forbidden />
  throw err
}
```

But `isPermissionError` (in `packages/canopycms/src/utils/error.ts`) checks Node's
filesystem error codes:

```typescript
export function isPermissionError(err: unknown): boolean {
  return isNodeError(err) && err.code === 'EACCES'
}
```

A denied `canopy.read()` throws `ContentStoreError` with `code: 'FORBIDDEN'`
(`content-reader.ts`'s `readDocument`), not a Node `EACCES`/`EPERM` filesystem error.
`isNodeError` itself would actually return `true` for a `ContentStoreError` (it only
checks `err instanceof Error && 'code' in err`), but `isPermissionError`'s stricter
`err.code === 'EACCES'` check never matches `'FORBIDDEN'`. So the README's
`isPermissionError(err)` branch is dead code for this use case: it always falls
through to `throw err`, not `<Forbidden />`.

## Why it matters

An adopter following this documented pattern for a permission-denied `read()` will
see the error re-thrown instead of getting their `<Forbidden />` fallback, likely
surfacing as an unhandled 500 rather than the graceful UI the example implies.

## Suggested fix (not applied here — out of scope for this change)

Either:

1. Document checking `err instanceof ContentStoreError && err.code === 'FORBIDDEN'`
   directly in the example (import `ContentStoreError` from `canopycms`), or
2. Add a dedicated helper (e.g. `isContentForbiddenError`) alongside the Node-error
   helpers in `utils/error.ts` and have the README example use that instead.

Note: `readByUrlPath` (as opposed to direct `read()`) no longer needs this pattern at
all for the common "render as 404" case — as of 2026-07-24 it swallows `FORBIDDEN`
and returns `null`, so `if (!result) return notFound()` already covers it. This doc
bug only affects adopters calling the strict `read()` API directly.

## Where to look

- `README.md` — "Error Handling Utilities" section (~lines 1569-1599)
- `packages/canopycms/src/utils/error.ts` — `isPermissionError`, `isNodeError`
- `packages/canopycms/src/content-reader.ts` — `readDocument` throws
  `ContentStoreError(..., 'FORBIDDEN')` on a denied read

## Acceptance

- README's Error Handling Utilities example either uses a check that actually
  matches a `canopy.read()` permission denial, or a new helper is added that does,
  with a short test.
