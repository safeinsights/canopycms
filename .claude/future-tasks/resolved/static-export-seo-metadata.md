# Static-export SEO metadata helper

**RESOLVED (2026-08-14, epic `integration-202608-b`)** — shipped alongside #10
([static-export-sitemap.md](static-export-sitemap.md)) in one change. Delivered:
`defineSeoFieldGroup()` (`entry-schema.ts`), core `extractSeoFields` /
`isNoindexEntry` / `resolveSeoUrl` (`static/seo.ts`), Next `entryToMetadata`
(`canopycms-next/src/static.ts`) bound on `NextCanopyContextResult`, and
reference usage in `apps/example1/app/posts/[slug]/page.tsx`.

Resolutions of the open design questions below: flat (inline) is the recommended
convention and the default, with the nested one supported via a `group` option on
BOTH ends; OG image URLs resolve against an explicit `siteUrl` (image dimensions
not emitted); title templating via `titleTemplate`; JSON-LD remains a separate
follow-up; i18n alternates out of scope. The coordination note ("exclude noindex
pages from the sitemap") became the design's centre — `isNoindexEntry` is a single
predicate feeding both `robots` and sitemap exclusion, which is why the two helpers
had to ship together.

NOTE: This was written in terms of static support, but should also support dev and prod server capabilities

## Problem

Adopters must hand-map an entry's SEO fields to Next `Metadata` (title / description / OpenGraph /
Twitter / canonical) on every page. CanopyCMS provides no helper, and there's no recommended SEO
field-group convention — so each adopter invents field names (the example app uses an ad-hoc
`metaTitle` / `metaDescription` inline group).

**Raised stakes (2026-08-14).** The branch-only decision in
[draft-publish-lifecycle.md](../draft-publish-lifecycle.md) makes `noindex` the **sole per-entry
visibility lever** in the product. This is therefore not just an ergonomics helper — it owns the only
control an adopter has over whether a merged entry is advertised. `../website` has already forked a
local copy (`src/lib/seo.ts`, with `extractSeoFields` + `DEFAULT_SEO_FIELD_NAMES`) and routes four
surfaces through it; that fork should be deleted in favour of the package version once this ships.

## What's available to build on

- Entries already carry SEO fields as flat content; `defineInlineFieldGroup` / `defineNestedFieldGroup`
  (`entry-schema.ts`) make a reusable SEO group trivial. The example's `seoGroup` is in
  `apps/example1/app/schemas.ts`.
- Entry data is available at build via the build-context `read` / `readByUrlPath` / `listEntries`.
- The neutral `static/` core module is the home for the framework-agnostic part.

## Proposed solution

- Ship a **recommended SEO field group** (`defineSeoFieldGroup()` or an exported `seoGroup` const)
  covering `metaTitle`, `metaDescription`, `ogImage`, `ogType`, `canonical`, `noindex`, `twitterCard` —
  consistent schema + derived types for adopters.
- Core (`static/`): `extractSeoFields(entryData, opts?)` → neutral
  `{ title?, description?, ogImage?, canonical?, noindex?, ... }`, field names configurable with
  defaults matching the recommended group.
- Next adapter: `entryToMetadata(entryData, opts?)` → `Metadata` (title, description, openGraph,
  twitter, `alternates.canonical`, `robots.noindex`), with site-level default/fallback metadata and a
  title template (`%s | Site`).

## Design questions to resolve

- Field-group convention: inline (flat) vs nested (`seo.*`) — recommend one, support both via opts.
- OG image URL resolution (relative → absolute needs `baseUrl`); image dimensions.
- Title templating (per-page title + site template).
- JSON-LD / structured data: likely a separate follow-up.
- `noindex`/robots ↔ canonical interplay; i18n alternates (probably out of scope v1).
- Coordinate with the sitemap helper (exclude `noindex` pages from the sitemap) — under the
  branch-only decision that is the *only* per-entry exclusion either helper applies.

## Affected files

- `packages/canopycms/src/static/` — `extractSeoFields`; possibly `defineSeoFieldGroup` in `entry-schema.ts`
- `packages/canopycms-next/` — `entryToMetadata`
- `apps/example1` — recommended SEO group + `generateMetadata` usage
- README / DEVELOPING — adopter docs

## Context

Split out of the safeinsights/website CanopyCMS-requests remediation plan (request #3) so SEO gets
deliberate design (the full metadata surface + a recommended schema) rather than a thin mapper. P2.
