---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-11, from WS7a-1's code review. `LocalAssetStore.listMeta`'s cursor is the last page's hash32; if that asset is deleted mid-walk, the next request falls back to page 1. The media library now reports that as an error and restarts on Retry, but the cursor should resume by sort position
---
# The local asset store's list cursor resets when its anchor is deleted

`LocalAssetStore.listMeta` (`packages/canopycms/src/assets/store-local.ts`) encodes the cursor
as the last returned asset's `hash32`. When that asset is removed before the next request, the
store can't find it and starts again from index 0, returning page 1 with a cursor the client
has already seen.

The media library's background walk (`editor/media/useAssetLibrary.ts`) treats a repeated cursor
as "the library changed while it was loading": it shows an error and Retry starts the walk over,
so it never claims to be complete with pages missing. That is correct but costs a full reload
whenever another editor removes the wrong asset at the wrong moment.

## Fix

Encode `(uploadedAt, hash32)` in the local cursor and resume at the first entry after that
position in the store's sort order, so a deleted anchor doesn't reset the walk. Check the S3
store's ListObjectsV2 continuation token for the same property; it is unverified whether a token survives deleting the key it was issued after. This is
an API-internal change; WS7a-2's asset index in [ui-epic-202610.md](ui-epic-202610.md) may
replace the listing altogether, so decide there first.
