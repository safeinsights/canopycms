# Block a URL collision at the write boundary, not just at the build

**Status: RESOLVED** (2026-08-21, branch `fix/url-collision-authoring-guard`, epic
`adopter-request-intake`). See "What shipped" — including a correction to the site list below.

Originally filed: **Priority: P2.** Split out of
[url-resolver-index-entry-extra-url.md](url-resolver-index-entry-extra-url.md) on
2026-08-21 as its deferred half, with the direction already decided — the open work is the four
call sites and their error surfacing, not whether to do it.

## What

A production build now fails when two entries claim the same `urlPath`
(`assertNoDuplicateUrlPaths`, `static/index.ts`). That is detection. The CMS should also refuse to
*create* the state in the first place.

The invariant is **"no two entries may claim the same `urlPath`"** — deliberately not "no two
things may share a name". The distinction is load-bearing:

- entry `guides` + sibling collection `guides` with **no** index entry → **legitimate**, works
  today, must not be blocked. It is a landing page plus a folder of children; nothing is contested.
- entry `guides` + sibling collection `guides` **with** an index entry → contested. Both compute
  `/docs/guides`, one of them is unreachable.

A name-collision rule would break the first case. Formulate the check as "would this write give a
second entry an existing `urlPath`?" and it also picks up case-only collisions for free, since
`urlPath` is lowercased.

## Why this is completing an existing rule, not adding a new one

Entry-vs-entry slug uniqueness within a collection is already enforced at the write boundary,
**across entry types as well as within one**:

- `content-store.ts`'s `buildPaths` resolves a write by scanning the collection directory for any
  file whose slug matches, deliberately entry-type-agnostic — it reads each candidate's own type
  out of its filename and compares slugs only. A same-slug file of a different type therefore
  resolves onto that existing file, and the requested entry type is discarded in favour of the
  existing one (`finalEntryTypeName = existingEntryType || entryTypeName`, "immutable after
  creation").
- The `expectedVersion: null` create-intent guard turns that resolution into
  `ContentConflictError('An entry with this slug already exists')`.
- `renameEntry` re-checks by directory scan "regardless of ID", and `extractSlugFromFilename`
  strips whatever type prefix each file actually has, so cross-type collisions are caught there too.
- The lock-key reclassification loop exists specifically to keep this true under concurrency —
  "two same-slug files" is named as the failure it prevents.

Entry-vs-sibling-collection is the one remaining hole in that invariant.

## The four call sites, both directions

- create entry with slug S in collection C → reject if C has a subcollection named S *that has an
  index entry*
- rename entry to slug S → same check
- create collection N under parent P (`schema-store.ts`'s `createCollectionInner`) → reject if the
  new collection would carry an index entry onto a `urlPath` P's entries already claim
- rename a collection (`updateCollection`'s `slug` — an atomic directory rename that re-paths
  everything beneath it) → same

The check must live in `content-store.ts` / `schema-store.ts`, not the API layer: content-store's
own comment records that the API layer's pre-write existence check "went stale under concurrency",
and that the authoritative check runs inside the per-entry lock against a fresh stat.

## What this does NOT replace

The build guard. Content is git-backed — it arrives by merge, by PR, by direct commit, and by
adopters retrofitting CanopyCMS onto an existing repo, none of which pass through the write
boundary. Pre-existing collisions already on disk are likewise untouched by a create-time check.
Prevention alone would be a guard with a hole in it.

## Open questions

- Which error code each of the four sites returns, and whether it reuses `ContentConflictError`
  (409) or wants its own.
- What the editor shows. A create rejected for this reason needs a message that names the sibling
  collection, or the author cannot act on it.
- Whether rename offers a fix-up rather than only refusing.

## Related

- [url-resolver-index-entry-extra-url.md](url-resolver-index-entry-extra-url.md) — the
  detection half, shipped.
- [collection-sibling-name-uniqueness.md](../collection-sibling-name-uniqueness.md) — the adjacent
  hole found while checking this one: `createCollection` does not check sibling names *at all*.

[MKT]

---

## What shipped

The invariant is enforced at the write boundary by `url-collision.ts`'s `findUrlPathClaimant`,
called from `ContentStore.assertUrlPathAvailable` (create + rename) and from `SchemaOps`'
collection-rename path. Refusals are `UrlPathConflictError`, a `ContentConflictError` subclass —
the established pattern here, so every existing 409 mapping keeps working while the API can
surface this specific message instead of "modified by another editor".

**Correction to the four-site list above: there are THREE sites, not four.**

`createCollection` needs no check at all. `createCollectionInner` creates the directory and its
`.collection.json` with `order: []` and **no entries**, and nothing in the editor creates an index
entry alongside it — so a new collection cannot contest a URL until an index entry is written into
it, which is the entry-side check. The site the original list missed is **collection RENAME**,
which re-paths every entry beneath it and therefore moves the collection's index entry onto the
new name.

The three real sites:

1. `ContentStore.write`, create only (`!existed`). Deliberately not on an ordinary save: the
   entry's URL is not changing, the collision predates the write, and refusing would trap the
   author in an entry they could no longer fix. Runs inside the same per-entry lock and the same
   in-lock re-resolution as the create-intent guard, so a concurrent create cannot slip between
   the check and the write.
2. `ContentStore.renameEntry` — a rename moves the entry to a new URL, including the `index`
   direction, which is how an existing collection acquires a landing page.
3. `SchemaOps.updateCollection`'s directory-rename branch. Only the index entry can collide there:
   the pre-existing sibling-name check has already established that no `{slug}.{id}` directory
   exists at the destination, so nothing deeper has anything to collide with.

Only the two cross-collection shapes are checked. Entry-vs-entry within one collection was already
refused upstream (`buildPaths`' type-agnostic slug scan plus the `expectedVersion: null` guard), so
re-checking it would be a second source of truth.

Answers to the open questions above: the error code is `UrlPathConflictError` (409) on the entry
sites and a plain `Error` (400) on the schema site, matching each module's existing convention;
the message names the conflicting entry and its path so the author can act; rename refuses rather
than offering a fix-up, since the correct fix depends on which of the two pages the author meant
to keep.

Every test was break-and-rerun verified: disabling the entry guard fails exactly the five REFUSES
tests and leaves the three ALLOWS tests passing (they guard against over-blocking), and disabling
the collection-rename guard fails exactly its one REFUSES test.
