# URL resolution: every `index` entry answers at a second URL, and a flat entry can shadow a nested collection

**Status: RESOLVED** (2026-08-21, branch `fix/url-resolver-index-entry-extra-url`, epic
`adopter-request-intake`). See "What shipped" at the bottom — including one correction to the
analysis below and one consequence neither this file nor the adopter had found.

Originally filed: **Priority: P1.** Found 2026-08-20 reviewing the marketing site's
`int-official-content` branch (PR #80). Corresponds to the adopter's standing request **#22**
(`docs/canopycms-requests.md` in the marketing-site repo) — cite that number, it is referenced
from `docs/adopter-migration.md` and from code comments in their repo.

## Problem

`resolveUrlPathCandidates` builds its candidate list in one fixed order:

```
packages/canopycms/src/url-path-resolver.ts:24-36
  // Try 1: last segment is the entry slug, rest is the collection path
  candidates.push({ entryPath, slug })
  // Try 2: full path is a collection with an index entry
  candidates.push({ entryPath: `${contentRoot}/${segments.join('/')}`, slug: 'index' })
```

Two distinct consequences fall out of that ordering. They share one root cause and should be
fixed — or consciously accepted — together.

### (a) An `index` entry is reachable at two URLs, contradicting `listEntries`

`listEntries` assigns each entry exactly ONE `urlPath`, collapsing `index` entries onto their
collection path, and that collapsing is documented as round-trip safe (see
[readbyurlpath-collection-url-support.md](readbyurlpath-collection-url-support.md), which
introduced it). But because Try 1 fires first, `readByUrlPath('/x/index')` matches
`{ entryPath: 'content/x', slug: 'index' }` — the index entry itself. So the entry answers at both
`/x` and `/x/index`, and enumeration and resolution disagree about how many URLs exist.

The literal segment `index` is not a corner case invented for this report: it is the slug the
`index` convention requires on disk, so the collision is structural, not accidental.

### (b) A flat entry in the parent collection shadows a nested collection's index

Same ordering, worse failure. For `/resources/case-studies`, Try 1 is
`{ entryPath: 'content/resources', slug: 'case-studies' }` — a plain entry sitting beside the
child collection. If one exists, it wins, and the entire `case-studies` child collection's index
becomes unreachable. Nested collections are a supported, documented feature
(`content-tree.ts:122` interleaves entries and subcollections by the `order` array), so this
precedence quietly makes them unsafe. Nothing in the package detects the shadowing.

## Adopter cost, already paid

The marketing site hit (a) on all three of its slug routes. Every one now carries an `entryType`
gate purely to reject the phantom URL — e.g. `src/app/resources/case-studies/[slug]/page.tsx:29-53`,
whose 25-line JSDoc exists to explain it:

> `/resources/case-studies/index` resolves to the `caseStudyIndex` singleton … Without this check
> that URL renders index data through the case-study template: no title, no body, every field
> undefined.

They then discovered (b) themselves while nesting `case-studies` under `resources`, and are holding
the line with their own `content-integrity.test.ts` duplicate-URL assertion — an adopter-side test
guarding a package-side invariant.

## Not a relitigation

The Try 2 index fallback was added deliberately and described as "Small, backward-compatible" in
[readbyurlpath-collection-url-support.md](readbyurlpath-collection-url-support.md). The
extra URL is a side effect of the *pre-existing* Try 1 rule interacting with it, not a considered
decision — nothing in that file weighs `/x/index` at all.

## Suggested fix

The adopter's proposal: skip Try 1 when its slug is literally `index`, so the only way to reach an
index entry is its collapsed path. That closes (a) cleanly.

(b) needs a separate decision, because both orderings are defensible: prefer the flat entry (today)
or prefer the nested collection's index. Whichever is chosen, the loser should be *detectable* —
the ambiguity is currently silent in both directions. Consider surfacing it in `branch-health.ts`,
which already classifies structural problems under a branches root, or in the duplicate-URL space
`content-integrity`-style checks occupy.

Both are routing behaviour changes and need an entry in `docs/adopter-migration.md`.

## Verification

Reproducible without writing code: `readByUrlPath('/resources/case-studies/index')` against the
marketing site's tree returns the `caseStudyIndex` singleton — precisely what their route's
`entryType` gate exists to reject.

---

## What shipped

Both consequences addressed, plus a third nobody had found.

**(a) — fixed as proposed.** `resolveUrlPathCandidates` skips its direct-entry candidate when the
last segment is literally `index`, so an index entry is reachable only at its collapsed collection
path. `readByUrlPath('/x/index')` and `readByUrlPath('/index')` now return `null`. The index
fallback is kept unconditionally, which is what makes this a skip rather than a removal — see the
third finding below.

**(b) — precedence deliberately left as-is, and made loud instead.** JP's call, on a tradeoff this
file framed as open. The deciding fact was a shape this file did not distinguish: an entry beside a
same-named sibling collection that has **no** index entry is legitimate and works today — a landing
page plus a folder of children, nothing contested. Preferring the nested collection would break it
the moment anyone added an index entry, silently taking down an already-published landing page from
elsewhere in the tree. Keeping the flat entry's precedence means adding that index entry produces
something merely redundant, which is then reported.

So the invariant enforced is **not** "no two things may share a name" — it is **"no two entries may
claim the same `urlPath`"**, which leaves the legitimate shape alone and additionally catches
case-only collisions (`urlPath` is lowercased) and same-slug-different-entry-type pairs that
arrived via git rather than the write boundary. `findDuplicateUrlPaths` / `assertNoDuplicateUrlPaths`
in `static/index.ts` run inside `enumerateRoutableEntries` under the same `isBuildMode()` gate as
the sibling schema-validity guard, so a **production build** fails naming every contested URL and
its claimants; `next dev` and the admin UI are untouched. `findDuplicateUrlPaths` is exported from
`canopycms/server` so the adopter's `content-integrity.test.ts` can call it instead of re-rolling
the scan. `canopycms-next`'s `dedupeSitemapItems` stays — it covers the entry-vs-`extraUrls` case
the content enumeration cannot see, and non-build-mode calls.

**(c) — a collection literally NAMED `index` was being shadowed.** Not in this file, not in the
adopter's report, found while checking that the fix for (a) was safe.
`defaultBuildPath(kind: 'collection')` hands such a collection the path `/x/index`, but the
direct-entry candidate fired first and returned the PARENT's index entry instead — the wrong
document, silently. Verified red before the fix (`/docs/index` returned `'Docs Home'` rather than
the `index` collection's own entry) and green after. This is why the index fallback had to survive.

**One correction to the analysis above.** The concern that changing `index` URL semantics would
propagate into resolved references (which gained a `urlPath` in #245, after this was filed) does
not apply. `computeEntryUrl` never emits a trailing `/index`, and neither does `defaultBuildPath`
for `kind: 'entry'` — every forward surface already agreed that an index entry has exactly one URL.
This was a reverse-only change that made the resolver agree with them, so no resolved reference's
value changed. The stale "they disagree" premise in `content-store.ts`'s comment was updated.

**Deferred, with its own file:**
[url-collision-authoring-guard.md](../url-collision-authoring-guard.md) — the same invariant
enforced at the write boundary, so the state cannot be authored through the CMS at all. Entry-vs-entry
slug uniqueness is already enforced there across entry types; entry-vs-sibling-collection is the one
remaining hole.
