# The contested-URL guard accepts all four content extensions, not a collection's configured ones

**Status:** Open. **Priority: P3.** Found 2026-08-21 by round 2 of the review of
[url-collision-authoring-guard.md](resolved/url-collision-authoring-guard.md). Deliberately left
open rather than fixed in that branch — the reasoning is below, and the residual behaviour is
documented at `CONTENT_EXTENSIONS` in `url-collision.ts` rather than papered over.

## What

`url-collision.ts`'s `entrySlugOf` accepts any of `.md`, `.mdx`, `.json`, `.yaml`.
`listCollectionEntries` accepts only the extensions of the collection's OWN configured entry-type
formats (it builds `validExts` from `getFormatExtension` over `collection.entries`).

So the guard is slightly LOOSER than the listing. A file like
`doc.index.aB3cD4eF5gH6.json` sitting inside an md-only collection:

- publishes no `urlPath` — `listEntries` skips it, so the build-time guard never sees it;
- is skipped **silently** — the extension filter runs before `parseTypedFilename`, so the
  listing's malformed-entry guard does not report it either;
- but DOES register as a claimant here, so it blocks a sibling create or rename.

That is an over-block, which is the failure mode this guard most needs to avoid: it refuses a
write the build would have accepted, and points the author at a file Canopy will never publish.

Reachable by an adopter who switches an entry type's format and leaves the old files behind, or
who hand-authors the wrong extension during a retrofit.

## Why it was not fixed in the branch that found it

Closing it exactly means the guard needs each collection's configured formats. The awkward part is
not passing them — it is that the claimant may live in a DIFFERENT collection than the one being
written to (the child collection for the sibling-index direction, the parent for the index
direction), so the guard would have to map a PHYSICAL directory back to a schema item to look up
its formats, at three call sites, inside a module that is deliberately schema-free.

That is more room to introduce a new defect than the narrow one it closes — and this branch's own
review history is four rounds in which the majority of findings were defects introduced by the
previous round's fix. Left as documented looseness rather than fixed under time pressure.

## Fix sketch

Give `findUrlPathClaimant` an optional `formatsFor?: (collectionDir: string) => readonly string[]`.
`ContentStore` can implement it from `this.schemaIndex` once there is a reliable physical→logical
mapping (`resolveCollectionPath` goes the other way; the inverse needs care with content IDs).
`SchemaOps` has the collection meta in hand at its call site and can supply it directly. When the
callback is absent, keep today's all-four behaviour so the module stays usable without a schema.

Worth doing at the same time: decide whether the LISTING should be case-insensitive about
extensions instead. Today both are case-sensitive and agree, but a `.MD` file silently publishes
nothing, which is its own small trap.

## Related

- [url-collision-authoring-guard.md](resolved/url-collision-authoring-guard.md) — the guard this
  refines.
- [migrate-preflight-url-collisions.md](migrate-preflight-url-collisions.md) — the migrate CLI's
  `.yml` handling produces exactly this class of file.

[NEITHER]
