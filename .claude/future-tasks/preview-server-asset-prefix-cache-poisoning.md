# The preview's server asset prefix can poison cross-request caches

**Status:** Open. **Priority: P3.** Filed 2026-10-08 from two reviews of the preview first-paint
fix. Accepted and documented (README "Live Preview", `docs/adopter-migration.md`, the comment on
`previewRequest` in `canopycms-next/src/preview-page.tsx`); this file holds the remedy if an
adopter hits it.

## State

Inside a `createPreviewPage` request, every server-side `assetUrl` call puts `/assets/t/` srcs
behind the signed-in raw route, through a request-scoped React `cache()` value. Output computed
there and stored across requests carries that prefix:

1. An adopter wraps a helper that calls `assetUrl` in `unstable_cache`, or memoizes its result at
   module level.
2. A preview request's `load` calls it first and fills the cache with
   `/api/canopycms/assets/raw/assets/t/…` URLs.
3. A public page served by the **same Next process** reads the cached value, so anonymous
   visitors get broken images (the raw route requires a session) until the cache is revalidated,
   or for good with a module memo.

`'use cache'` is unaffected: it renders in its own Flight request. A static-export public site is
unaffected: its pages never share a process with the preview route. The prefix is
`basePath` + `/api/canopycms/assets/raw`, with no branch name and no token, so a poisoned cache
exposes nothing but that path.

## Remedy if an adopter hits it

Drop the ambient server prefix: give `load` an explicit `assetBase` on its context and let the
adopter pass it to `assetUrl` for `extras`. That is a new adopter touchpoint, so it needs
approval.
