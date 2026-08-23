# `readByUrlPath('/<entryTypeName>')` resolves a collection's index entry — a second URL the forward rule never emits

**Priority:** P2 — breaks a documented invariant and is now reachable in the shape the README
recommends, but no in-repo app serves a route for the phantom URL today
**Found:** 2026-08-21, by an independent review of `feat/sitemap-path-for-index-entries`
(adopter request log #20). Pre-existing; that branch created the first live instance.

## Problem

`AGENTS.md` states the invariant plainly: the forward rule (`computeEntryUrl`) and the reverse one
(`resolveUrlPathCandidates`) must agree that an index entry answers at **exactly one** URL, its
collapsed collection path. PR #253 closed the `/x/index` half of that. This is a second, distinct
hole in the same invariant, and it is still open.

`resolveUrlPathCandidates('/home', 'content')` returns two candidates:

```
[ { entryPath: 'content',      slug: 'home'  },   // 1: last segment is the slug
  { entryPath: 'content/home', slug: 'index' } ]  // 2: whole path is a collection with an index
```

Candidate 2 assumes `content/home` is a **collection**. When the content root declares an entry
**type** named `home`, `content/home` is a registered entry-type schema item instead
(`config/flatten.ts`), and `ContentStore.buildPaths`' entry-type branch (`content-store.ts`,
`effectiveSlug = slug || schemaItem.name`) delegates it to the **parent** collection with slug
`index` — which resolves that collection's index entry.

So a root index entry answers at both `/` and `/home`. Generalised: for any collection that has an
index entry, `/<collection>/<entryTypeName>` also resolves it — the scan matches on slug alone, so it
holds even when the index entry's own type differs from the probed name. One exception: if that
collection also holds a real entry whose slug literally equals the entry-type name, candidate 1 wins
and that entry answers instead, which is a collision rather than a phantom.

## Confirmed, not inferred

Probed against a real `ContentStore` over a replica of `apps/example1`'s root collection (entry
type `home`, `maxItems: 1`, single file `home.index.<id>.json`):

```
candidates("/home") -> [{content, 'home'}, {content/home, 'index'}]
read(content/home, index)  => { hero: 'Welcome home' }   <-- resolves
read(content, index)       => { hero: 'Welcome home' }   <-- the legitimate '/' route
```

## Why it matters more now

`README.md` recommends modelling a home page as a root `index` entry (the modelling that removes
the sitemap workaround — see adopter request log #20). That recommendation is right, and it is also
what makes this hole reachable: an adopter combining it with a root catch-all (`app/[[...slug]]`)
serves a **duplicate homepage** at `/home`, with no warning. `apps/example1` is not affected today
because it has no root catch-all, so `/home` has no route and Next 404s it — but nothing enforces
that, and the README now carries a caveat pointing here.

`assertNoDuplicateUrlPaths` does not catch this: it scans `urlPath` values from the forward
enumeration, and the forward rule never emits `/home` at all. The disagreement is one-directional,
which is exactly what makes it invisible.

## Suggested fix

The fix belongs in URL resolution, **not** in `ContentStore`. The entry-type delegation in
`buildPaths` is a deliberate, documented feature of direct `ContentStore`/`read({ entryPath })`
usage, with its own test (`content-store.test.ts`, "entry-type path delegation") — narrowing it
would break a supported API.

Make `readByUrlPath` (`context.ts`) skip the index-fallback candidate when its `entryPath` resolves
to an entry-**type** schema item rather than a collection. The forward rule never emits
`/<collection>/<typeName>`, so that candidate can only ever produce a phantom URL.

The obstacle, and the reason this was not fixed inline, is narrower than "no schema is reachable" —
an earlier draft of this file overstated it. `context.ts`'s `getContext` closure DOES resolve a flat
schema, via `services.branchSchemaCache.getSchema(branchRoot, registry, contentRootName)` inside
`resolveSchemaContextImpl`, a few dozen lines below `readByUrlPath`. Two things still stand in the
way: that flat schema is a list, not a logicalPath-keyed index, so a lookup would have to be built;
and `resolveSchemaContextImpl` is memoized against the DEFAULT branch, while `readByUrlPath` takes a
per-call `branch` — so reusing it as-is would consult the wrong branch's schema for any non-default
read. Options, roughly in order of preference:

1. Expose a narrow predicate off `ContentStore` (it already holds `this.schemaIndex`), e.g.
   `isCollectionPath(logicalPath)`, and consult it in the candidate loop.
2. Thread the flattened schema into `readByUrlPath` and check there.
3. Have the candidate carry an "only if this is a collection" flag that the reader honours.

Whichever is chosen, add tests for: the phantom is gone (`/home` -> null), the legitimate
candidate-2 case still resolves (`/docs/guides` -> the guides index entry), a collection literally
named `index` still resolves, and direct `read({ entryPath: 'content/home' })` is untouched.

## Related

- [adopter-request-log-intake.md](../adopter-request-log-intake.md) — item #20, whose fix exposed this
- [url-resolver-index-entry-extra-url.md](url-resolver-index-entry-extra-url.md)
  — the `/x/index` half of the same invariant, closed by PR #253
- [isurlpath-field-marker.md](../isurlpath-field-marker.md) — its "singletons are routable" bullet is
  about this same area

---

## RESOLVED — 2026-08-22, branch `fix/readbyurlpath-url-addressable-only`

Adopter request **34** (the remainder of #22), reported against `0.0.65`. Fixed as suggested — in
URL resolution, not in `ContentStore` — but scoped wider than this file proposed, for three
reasons the write-up did not anticipate.

**1. There were two phantom families, not one.** This file describes the index-fallback candidate
landing on an entry-type item. The DIRECT-entry candidate does the same thing one level up:
`/<collection>/<typeName>/<slug>` resolves `<collection>` + `<slug>`. It needs no index entry, so
unlike the family described here it applies to **every entry in every collection** — strictly the
larger hole, and neither the adopter nor this file had it. `apps/example1` was serving seven
duplicate doc pages through it (`/docs/doc/overview`, `/docs/api/doc/intro`, and siblings), live
under `app/docs/[[...slug]]`, while `/home` — the instance this file tracks — 404s there for want
of a route. The fix is therefore stated as an invariant rather than as a skipped candidate: **for a
published URL, every candidate's `entryPath` is a collection.**

**2. The obstacle this file records was real but avoidable.** Option 1 was taken —
`ContentStore.isCollectionPath()`, consulted on the read path — and it is the only one of the three
that is structurally safe. Option 2 (thread the flat schema into `readByUrlPath`) would have been a
latent bug: the flat schema is a LIST and a `find` over it is first-wins, while `schemaIndex` is a
Map and is last-wins. Where a subcollection's path equals a parent's entry-type name the two
disagree, and the list would have reported `entry-type` for something `buildPaths` resolves as a
collection — closing a legitimate URL. Reading the same Map `buildPaths` reads is what makes gate
and resolver unable to diverge. The per-call-branch problem noted here dissolved once the check
moved into `content-reader.ts`, which already builds a per-branch store.

**3. A third disagreement was fixed in the same pass** (JP's call): an entry whose on-disk type
token its collection does not declare was resolvable by URL though `listEntries` skips it. Both
rules ride one flag, `ReadContentInput.urlAddressableOnly`, set by `readByUrlPath` and nothing else.
Note where that check is NOT: `buildPaths`' directory scan stays type-blind, because `write()`
resolves through it to decide edit-vs-create — rejecting there would mint a second same-slug file
on save and leave the mistake unfixable from the editor.

**Confirmed by construction, not just by test.** `isCollectionPath` is the non-throwing form of the
existing private `assertCollection`, type-only (not `resolvePath`'s stricter `type && entries`, or
it would reject a collection that has subcollections but no entries of its own).

**What was NOT closed**, and is now tracked separately: a legacy untyped file (`overview.json`) is
still readable by URL and invisible to `listEntries` — see
[legacy-untyped-files-url-addressable.md](../legacy-untyped-files-url-addressable.md). Rule 2 lets
those through by construction, since `extractEntryTypeFromFilename` returns `null` for them and the
collection's declared default is substituted; that is deliberate and pinned by a test, because
re-expressing the rule as a filename-grammar check would silently 404 every legacy entry.

**Tests.** `url-exclusivity-fixtures.ts` is the durable answer to the adopter's actual complaint —
that these were being found one at a time, a release apart. It enumerates, round-trips every
published URL, then probes every adjacent URL the resolver would attempt;
`url-exclusivity.test.ts` runs it over fixtures and `reference-app-url-exclusivity.test.ts` over
`apps/example1`'s real content tree, so the reference app is held to the invariant as it grows.
All five breaks were verified, including the decisive one: gating only the index candidate leaves
six tests failing.
