# URL resolution: every `index` entry answers at a second URL, and a flat entry can shadow a nested collection

**Status:** Open. **Priority: P1.** Found 2026-08-20 reviewing the marketing site's
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
[readbyurlpath-collection-url-support.md](resolved/readbyurlpath-collection-url-support.md), which
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
[readbyurlpath-collection-url-support.md](resolved/readbyurlpath-collection-url-support.md). The
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
