---
priority: P3
summary: >-
  An adopter with nested or renamed SEO fields states their location twice — `createNextCanopyContext({ seo })` for the sitemap and robots metadata, and `AIContentConfig.seo` for AI content — and the two can drift, leaving a `noindex` entry advertised in one surface and absent from another. The defaults are shared by construction (one `DEFAULT_SEO_FIELD_NAMES`); a configured location is not.
---

# One SEO field location for every advertising surface

`isNoindexEntry` (`packages/canopycms/src/static/seo.ts`) is the single `noindex` predicate, but
the field location it reads comes from two configs: the Next context's `seo`
(`packages/canopycms-next/src/context-wrapper.ts`'s `mergeSeoFieldLocation`) and the AI config's
`seo` (`packages/canopycms/src/ai/types.ts`). The README tells adopters to pass one object to both;
nothing enforces it.

## Options

1. Move the location into `CanopyConfig` (e.g. `seo?: SeoFieldLocation`), read by
   `createNextCanopyContext`, `createAIContentHandler` and `generate-ai-content`, with the per-call
   options still overriding. One source, but a new config key (needs approval as a touchpoint
   change).
2. Keep both, and have `generate-ai-content` / the handler warn when the AI config's `seo` is unset
   but entries carry an SEO group the default location can't see. Cheaper, heuristic.
