---
priority: P3
adopters: NEITHER
summary: >-
  New 2026-10-05. Three non-ACL sites (`useEntryManager`, `ai/generate.ts`, `ContentStore.renameEntry`'s `newPath`) still hand-build `collection/slug` instead of calling `entryLogicalPath`, and `buildPaths`'s doc overstates what runs before file I/O
---
# Entry logical paths are still hand-built in three places

## Priority: P3 [NEITHER]

`paths/normalize.ts` `entryLogicalPath(collection, slug)` is the single builder of an entry's
logical path, the form path-permission rules match, and listing and every ACL check use it. Three
non-ACL sites still build `${collection}/${slug}` themselves: `editor/hooks/useEntryManager.ts`,
`ai/generate.ts`, and the `newPath` that `ContentStore.renameEntry` returns. They agree today; a
change to the rule (e.g. root-collection handling) would make them drift silently. Switch them to
`entryLogicalPath`.

Also: `ContentStore.buildPaths`'s doc says everything in it "runs BEFORE any file I/O … so
permission checks happen before filesystem access", but `buildPaths` itself reads the collection
directory. Shorten it to what is true: the slug and traversal checks run before the entry file is
read or written.
