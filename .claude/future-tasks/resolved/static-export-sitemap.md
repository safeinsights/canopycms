# Static-export sitemap helper

**RESOLVED (2026-08-14, epic `integration-202608-b`)** — shipped together with
#10a ([static-export-seo-metadata.md](static-export-seo-metadata.md)) in one
change, because the `noindex` flag has to suppress a page in both surfaces.
Delivered: core `collectRoutableEntries` (`static/index.ts`) and
`extractSeoFields`/`isNoindexEntry`/`resolveSeoUrl` (`static/seo.ts`); Next
`generateContentSitemap` (`canopycms-next/src/static.ts`), bound on
`NextCanopyContextResult`; reference usage in `apps/example1/app/sitemap.ts`.

Resolutions of the open design questions below: `lastmod` defaults to
`listEntries`'s `updatedAt` and is pluggable via a `lastModified` callback,
with the mtime caveat documented rather than papered over; `noindex` is the
exclusion mechanism plus an `exclude` predicate (no separate "published"
convention — see [draft-publish-lifecycle.md](../draft-publish-lifecycle.md));
`robots.txt` is explicitly out of scope; `changeFrequency` is not emitted for
entries. The decision NOT taken from this file: enumeration includes every
routable entry type with no allow-list, because an allow-list is precisely what
shipped a production sitemap missing whole content types.

NOTE: This was written in terms of static support, but should also support dev and prod server capabilities

## Problem

Adopters building static (`output: 'export'`) Next sites must hand-roll `sitemap.xml` by enumerating
published content entries. The safeinsights/website adopter wrote `listPageUrls()` in
`src/lib/canopy-helpers.ts`; docs-site-proto will need the same. CanopyCMS ships no sitemap helper, so
every adopter reinvents enumeration + URL building + publish filtering.

## What's available to build on

- `getCanopyForBuild().listEntries<T>()` returns `ListEntriesItem` with a collapsed, URL-ready
  `urlPath` plus `pathSegments`, `slug`, `entryType`, `data` — `content-listing.ts:132-163`.
- URL derivation is centralized in `utils/entry-url.ts` (`computeEntryUrl`).
- Singletons are `maxItems: 1` entry types — `config/types.ts:171-181`.
- "Published" is a content-field convention (e.g. `published: true` in frontmatter), not schema-enforced.
- The neutral `static/` core module (added by the website-requests plan, for `collectStaticPaths`) is
  the home for the framework-agnostic part.

## Proposed solution

Framework-agnostic core + thin Next adapter:
- Core (`packages/canopycms/src/static/`): `collectPublishedEntries(buildCtx, opts?)` → neutral
  `{ urlPath, lastModified?, entryType, data }[]`. Filters by `opts.publishedField` (default
  `published`; absent field ⇒ published), includes `maxItems:1` singletons, supports `opts.exclude`
  (urlPath predicate/globs).
- Next adapter (`canopycms-next`): `generateContentSitemap(getCanopyForBuild, { baseUrl, ...opts })` →
  `MetadataRoute.Sitemap`. Maps neutral entries to absolute URLs; optional per-entry `lastModified` /
  `changeFrequency` / `priority` via callback.

## Design questions to resolve

- `lastmod` source: file mtime vs a content field (`updatedAt`) vs git commit time — make it pluggable.
- Exclusions: drafts (publish filter), `noindex` pages (SEO field), explicit excludes.
- robots.txt: ship a sibling helper, or out of scope?
- changefreq/priority: usually low value — expose via callback rather than baking in.
- Confirm `urlPath` round-trips for index/collection entries (it does per content-listing docs).

## Affected files

- `packages/canopycms/src/static/` — new `collectPublishedEntries` (+ tests)
- `packages/canopycms-next/` — `generateContentSitemap`
- `apps/example1/app/sitemap.ts` — reference usage
- README / DEVELOPING — adopter docs

## Context

Split out of the safeinsights/website CanopyCMS-requests remediation plan (request #3) so sitemap gets
deliberate design rather than a thin first cut. The static-params helper + build `readByUrlPath` ship in
that plan. Adopter workaround today: `listPageUrls()` in `../website/src/lib/canopy-helpers.ts`. P2.
