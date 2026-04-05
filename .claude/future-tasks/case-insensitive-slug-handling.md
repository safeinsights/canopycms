# COMPLETED — Case-insensitive slug handling

Resolved in branch `fix/case-insensitive-slug-handling`. Changes:

- Unified `CollectionSlug` + `EntrySlug` into single `Slug` branded type
- Centralized lowercase normalization in `extractSlugFromFilename` (returns `Slug`)
- Fixed `safeSlug` in `buildPaths` and `resolvePath` normalization
- Replaced `entrySlugSchema`/`collectionSlugSchema` with single `slugSchema`
