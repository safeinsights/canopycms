# `getErrorMessage(err, fallback?)` — the 27% is a signature gap, not laziness

## Priority: P2

Found 2026-08-23 by the [baseline structural evaluation](../../docs/reviews/2026-08-structure.md).

## Problem

`CLAUDE.md` says to use `getErrorMessage()` from `utils/error.ts`. Measured:
**120 call sites use it, 44 hand-roll** `err instanceof Error ? err.message : '<fallback>'`.

That reads like 73% compliance with a convention. It is not. Almost all 44 supply
a **domain-specific fallback** — `'Failed to load branches'`, `'Rename failed'`,
`'Push failed'` — which `getErrorMessage` structurally cannot express, because it
returns `String(err)` for a non-Error. The rule is unfollowable at those sites, so
"compliance" was never the issue.

## Fix

Add an optional second parameter to `utils/error.ts`:

```ts
export function getErrorMessage(err: unknown, fallback?: string): string
```

Returning `fallback ?? String(err)` on the non-Error branch. Then sweep.

This is the highest return-per-line item in the structural review: one signature
change moves a stated rule from 73% to ~99%, and removes 44 copies of a
conditional that can (and does) drift in its handling of non-Error throws.

## Where the 44 are

Client, with domain-specific fallbacks (the legitimate ones):

- `editor/hooks/useBranchManager.tsx` ×6, `editor/admin/useSystemHealth.tsx` ×8
- `editor/hooks/{useEntryManager,useGroupManager,usePermissionManager,useUserContext,useUserMetadata,useBranchActions}` ×7
- `editor/comments/{ThreadCarousel,InlineCommentThread}.tsx` ×4

Server, where the fallback is NOT domain-specific and this is straightforwardly a
miss:

- `api/github-sync.ts:110,157,194`; `services.ts:420,486`; `api/entries.ts:532`
- `worker/cms-worker.ts` ×7; `authorization/permissions/loader.ts:52`
- `canopycms-auth-clerk/src/{clerk-plugin.ts:266,cache-writer.ts:153}`

## Related

- [duplicated-helpers-consolidation.md](duplicated-helpers-consolidation.md) — same
  theme: a helper exists and call sites reimplement it
