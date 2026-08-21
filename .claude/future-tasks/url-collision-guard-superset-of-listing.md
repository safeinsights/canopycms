# The contested-URL guard's claimant set is a strict superset of the listing's, in three ways

**Status:** Open. **Priority: P3.** Found 2026-08-21 by round 2 of the review of
[url-collision-authoring-guard.md](resolved/url-collision-authoring-guard.md). Deliberately left
open rather than fixed in that branch — the reasoning is below, and the residual behaviour is
documented at `CONTENT_EXTENSIONS` in `url-collision.ts` rather than papered over.

## What

The invariant is "no two ENTRIES claim the same `urlPath`", and what counts as an entry is defined
by what `listEntries` publishes. `url-collision.ts` approximates that set without a schema, and
the approximation is LOOSER along three dimensions. Every one of them OVER-BLOCKS: it refuses a
write the build guard would have accepted, and points the author at a file Canopy never publishes.

**1. Extension.** `entrySlugOf` accepts any of `.md`, `.mdx`, `.json`, `.yaml`;
`listCollectionEntries` accepts only the extensions of the collection's OWN configured entry-type
formats (`validExts`, built from `getFormatExtension` over `collection.entries`).

**2. Entry type.** `entrySlugOf` parses structurally, so a file whose type is not in the
collection's config still counts. Confirmed end to end by review: a collection configured for
`['guide']` containing `article.index.{id}.json` lists **no** urlPaths, yet a sibling create is
refused naming that file. An earlier version of the code comment dismissed this as "already
reported by the listing's malformed-file guard" — true only in BUILD mode. In the editor, where
this guard runs, the listing skips the file with a debug-gated warning and nothing surfaces.
Reached by the accident `looksLikeMalformedEntry` names as most common: renaming an entry type in
`.collection.json` without renaming the files.

**3. Collection-hood.** `findChildCollectionDir` matches any child directory by name, but a
directory without `.collection.json` is not a collection (`schema/meta-loader.ts`), so nothing
inside it publishes a URL. Narrow — the file inside still needs valid entry grammar and a valid
ID — but the same direction.

Taking dimension 1 as the worked example, a file like
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

All three dimensions need the same thing — the collection's schema — so this is one task, not
three. Give `findUrlPathClaimant` an optional `schemaFor?: (collectionDir: string) => { entries } | null`
(returning null for a directory that is not a collection covers dimension 3 at the same time).
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
