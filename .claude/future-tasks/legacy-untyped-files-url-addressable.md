# A legacy untyped content file is readable by URL but invisible to every enumerating surface

**Priority:** P3 — a real enumeration/resolution disagreement, but it can only affect content that
predates the `{type}.{slug}.{id}.{ext}` filename grammar or was hand-authored against the old shape.
No in-repo app has such a file.
**Found:** 2026-08-22, while closing
[resolved/readbyurlpath-entry-type-candidate-phantom-url.md](resolved/readbyurlpath-entry-type-candidate-phantom-url.md).
Pre-existing; that fix scoped the invariant it asserts so this stays honestly out of scope rather
than silently claimed.

## Problem

`listEntries` decides whether a file is one of a collection's entries with
`parseTypedFilename(filename, collection.entries)`, which requires at least three dot-separated
segments before the extension. A legacy `{slug}.{ext}` file — `overview.json` — fails that and is
dropped. It is not even reported: `looksLikeMalformedEntry` (content-listing.ts) deliberately
returns `false` for a two-segment name, so the build-mode hard failure never fires on it either.

`readByUrlPath('/docs/overview')` resolves it anyway, because `ContentStore.buildPaths` finds
entries by scanning the directory for a matching slug and `extractSlugFromFilename` falls back to
"filename minus extension" when there is no embedded ID.

So the file is served at a URL that is absent from `listEntries`, `generateContentStaticParams`,
`buildContentTree` and the sitemap. Under a static export it is simply unreachable; under
`next dev` or `output: 'standalone'` it is a live page nothing advertises.

This is the same class as the two families closed in the resolved task above, and the reason it was
not closed with them is cost, not disagreement about whether it is a bug.

## Why it was left open

`urlAddressableOnly`'s declared-type rule (content-reader.ts) passes these files by construction:
`extractEntryTypeFromFilename` returns `null` for a legacy name, so `buildPaths` substitutes the
collection's DEFAULT entry type, which is declared. Closing this hole means adding a third rule —
the resolved file must itself satisfy `parseTypedFilename` — and that rule would be correct.

The cost is in the tests, not the code: roughly twenty existing fixtures in `context.test.ts` (and
several in `content-reader.test.ts`) write untyped filenames precisely because they predate the
grammar mattering, and every one of them reads back by URL. They would all have to be rewritten in
the same change, which would bury a one-line behaviour change in a large mechanical diff.

## Suggested fix

Add the rule under the same `urlAddressableOnly` flag, next to the other two, and migrate the
untyped fixtures in one separate mechanical commit first so the behaviour change is reviewable on
its own. `url-exclusivity.test.ts` already has the test that must flip:
"still resolves a legacy untyped file, which carries no type token to check" — it currently pins
the CURRENT behaviour and explains why, so closing this hole means rewriting that test's intent,
not deleting an oversight.

Worth deciding at the same time: whether a legacy file should instead become *visible* to
enumeration rather than invisible to resolution. That is the opposite fix and probably the kinder
one for an adopter retrofitting an existing repo — but it needs an entry type and a content ID
invented from nothing, which is what the grammar exists to avoid.

## Related

- [resolved/readbyurlpath-entry-type-candidate-phantom-url.md](resolved/readbyurlpath-entry-type-candidate-phantom-url.md)
  — the two families that WERE closed, and the `urlAddressableOnly` flag this would extend
- [resolved/url-resolver-index-entry-extra-url.md](resolved/url-resolver-index-entry-extra-url.md)
  — the first of these to be found, by an adopter
- [adopter-request-log-intake.md](adopter-request-log-intake.md) — items 22 and 34
