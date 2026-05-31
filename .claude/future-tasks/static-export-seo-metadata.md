# Static-export SEO metadata helper

## Problem

Adopters must hand-map an entry's SEO fields to Next `Metadata` (title / description / OpenGraph /
Twitter / canonical) on every page. CanopyCMS provides no helper, and there's no recommended SEO
field-group convention — so each adopter invents field names (the example app uses an ad-hoc
`metaTitle` / `metaDescription` inline group).

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
- Coordinate with the sitemap helper (exclude `noindex` pages from the sitemap).

## Affected files

- `packages/canopycms/src/static/` — `extractSeoFields`; possibly `defineSeoFieldGroup` in `entry-schema.ts`
- `packages/canopycms-next/` — `entryToMetadata`
- `apps/example1` — recommended SEO group + `generateMetadata` usage
- README / DEVELOPING — adopter docs

## Context

Split out of the safeinsights/website CanopyCMS-requests remediation plan (request #3) so SEO gets
deliberate design (the full metadata surface + a recommended schema) rather than a thin mapper. P2.
