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

What actually happens downstream (verified empirically on 2026-08-21 by building the scenario —
two sibling `guides.{id}` dirs each with a `.collection.json`, holding entries with NO slug
overlap), because it is not the obvious answer:

- Schema discovery emits **two** collection items with the **same logical path** — the meta loader
  pushes one per directory and nothing in `resolveCollectionReferences`/`flattenSchema`/
  `listEntries` dedupes by logical path.
- `content-id-index.ts`'s `resolveCollectionPath` resolves a logical path by `entries.find(...)`
  on the extracted name, so **both** items resolve to the SAME (first-found) directory.
- Net effect: the winner's entries are enumerated **twice**, and the shadowed directory's entries
  are **never enumerated at all**. The shadowed content is invisible, not merely un-URL-addressable.

**Two corrections to the obvious reading**, both of which this file originally got wrong:

1. The duplicate-`urlPath` build guard fires **whenever the winner directory contains any entry at
   all** — because every one of its entries is listed twice and so collides with itself. It does
   NOT depend on the two directories having overlapping slugs. Coverage is therefore wider than it
   looks, though it arrives by an accident of double-enumeration rather than by design.
2. The genuinely undetected case is a winner directory with **no entries** — then nothing collides,
   and the shadowed directory's content is silently absent.

Contrast entry creation, which *is* guarded: `content-store.ts`'s `buildPaths` scans for an
existing same-slug file (across entry types) and the `expectedVersion: null` create-intent guard
turns a hit into a `ContentConflictError`. And contrast **collection rename**, which is ALSO
guarded — `updateCollection`'s directory-rename path (`schema/schema-store.ts`, the
`updates.slug !== currentSlug` branch) scans the parent for any `{slug}.{valid-id}` directory and
throws `Collection with slug "X" already exists`. So creation is the lone unguarded door, which is
what makes this an oversight rather than a policy.

## Severity

Not urgent — it requires an editor to deliberately create two same-named siblings, and per
correction 1 above the duplicate-`urlPath` build guard (`assertNoDuplicateUrlPaths`,
`static/index.ts`) fails a production build in most reachable versions of the state. The gap is a
winner directory with no entries of its own, where the shadowed directory's content simply
disappears from every listing with nothing to notice.

## Fix sketch

Port the rename path's existing check to `createCollectionInner`: scan the parent for an existing
`{name}.{valid-id}` directory under the schema lock it already holds, and reject rather than
`mkdir`. The two should share one helper rather than being two copies of the same scan.

Worth deciding at the same time whether `resolveCollectionPath`'s `.find()` should stay
first-wins-silently or surface the ambiguity, given `branch-health.ts` already reports
`duplicateContentIds` from a comparable schema-free scan — and whether schema discovery should
reject two collection items resolving to one logical path, which is the actual mechanism above.

## Related

- [url-collision-authoring-guard.md](url-collision-authoring-guard.md) — the same class of missing
  write-boundary check, on the entry-vs-collection axis.
- [url-resolver-index-entry-extra-url.md](resolved/url-resolver-index-entry-extra-url.md) — added
  the build-time duplicate-`urlPath` guard that partially covers this.

[NEITHER]
