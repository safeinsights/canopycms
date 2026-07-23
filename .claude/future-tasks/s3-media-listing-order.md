# Future Task: S3 media-library listing order (dev vs prod divergence)

Status: **captured from the assets epic final review (finding #4), 2026-07-22.** Low
priority — a UX inconsistency, not a correctness bug.

## Problem

`S3AssetStore.listMeta` (`packages/canopycms/src/assets/store-s3.ts`) returns assets in
S3 key order — lexicographic by `hash32`, i.e. effectively random — because it lists the
`asset-meta/` prefix and paginates on the ListObjectsV2 continuation token.
`LocalAssetStore.listMeta` (`store-local.ts`) sorts newest-first by `uploadedAt`.

So the MediaLibrary is newest-first in dev but hash-ordered in prod. Within a session the
client prepends freshly uploaded assets, so the immediate UX is fine; but after a reload a
recently uploaded asset lands at an arbitrary position and may not be on page 1. The
design record described the listing as "cursor-paginated over `asset-meta/`" without
committing to recency order, so this is unspecified rather than wrong.

## Options

- Accept + document: prod media library is not chronologically ordered; rely on the
  filename filter to find assets. Cheapest.
- Maintain a recency index (e.g. an `asset-index/` object, or date-prefixed meta keys like
  `asset-meta/{sortable-ts}-{hash32}.json`) so ListObjectsV2's lexicographic order IS
  chronological. Adds a write on finalize + a migration for existing assets.
- Client-side sort of the loaded page(s) by `uploadedAt` — only orders within a page, not
  across the full set; partial fix.

Revisit when a site accumulates enough assets that "find my recent upload after reload"
becomes a real editor complaint.
