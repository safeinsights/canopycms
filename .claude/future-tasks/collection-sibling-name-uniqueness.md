# `createCollection` does not check sibling-name uniqueness at all

**Status:** Open. **Priority: P2.** Found 2026-08-21 while checking the write boundary's existing
slug-uniqueness guarantees for
[url-collision-authoring-guard.md](url-collision-authoring-guard.md). Pre-existing; unrelated to
the change that surfaced it.

## Problem

`schema-store.ts`'s `createCollectionInner` generates a fresh content ID and creates
`${input.name}.${contentId}` unconditionally. There is no check for an existing sibling with the
same logical name, at that layer or in `api/schema.ts`'s handler above it.

Two collections named `guides` under the same parent are therefore creatable, as
`guides.AAAAAAAAAAAA/` and `guides.BBBBBBBBBBBB/`. Both are added to the parent's `order` array.

Downstream, `content-id-index.ts`'s `resolveCollectionPath` walks logical path segments with
`entries.find(...)` on the extracted logical name — so **one of the two is silently unreachable**
by logical path, whichever the directory read happens to return second. Every entry under the
shadowed directory shares its logical collection path with an entry of the same slug under the
winner, so they collide on `urlPath` too.

Contrast entry creation, which *is* guarded: `content-store.ts`'s `buildPaths` scans for an
existing same-slug file (across entry types) and the `expectedVersion: null` create-intent guard
turns a hit into a `ContentConflictError`. Collections got none of that.

## Severity

Not urgent — it requires an editor to deliberately create two same-named siblings, and the
duplicate-`urlPath` build guard (`assertNoDuplicateUrlPaths`, `static/index.ts`) now fails a
production build if any entries actually collide as a result. But the shadowed collection can also
hold entries whose slugs happen not to collide, in which case nothing catches it and the editor
simply cannot reach some of their content.

## Fix sketch

Check for an existing sibling directory with the same extracted logical name inside
`createCollectionInner`, under the schema lock it already holds, and reject rather than `mkdir`.
`updateCollection`'s directory-rename path (`slug`) needs the same check against its new name —
renaming a collection onto an existing sibling's name has the identical outcome.

Worth deciding at the same time whether `resolveCollectionPath`'s `.find()` should stay
first-wins-silently or surface the ambiguity, given `branch-health.ts` already reports
`duplicateContentIds` from a comparable schema-free scan.

## Related

- [url-collision-authoring-guard.md](url-collision-authoring-guard.md) — the same class of missing
  write-boundary check, on the entry-vs-collection axis.
- [url-resolver-index-entry-extra-url.md](resolved/url-resolver-index-entry-extra-url.md) — added
  the build-time duplicate-`urlPath` guard that partially covers this.

[NEITHER]
