---
priority: P2
summary: >-
  RESOLVED (2026-10-11). AI content (`generate-ai-content` and the `/ai` route handler, both through `generateAIContent`) leaves out entries marked `noindex`, through `static/seo.ts`'s `isNoindexEntry` at the AI config's `seo` field location, as the sitemap does. `exclude.noindex: false` restores the old output; a non-boolean `exclude.noindex` or a misshapen `seo` is refused. Enumeration for building is unchanged. Body `entry:` links to left-out entries render as plain text ([folded P3](ai-content-entry-links-to-excluded-entries.md)).
---

# AI content ignores `noindex`

## Status: RESOLVED 2026-10-11

An adopter's stub entries marked `noindex: true` were correctly absent from the sitemap and carried
robots noindex, but `generate-ai-content` still wrote them to `public/ai/*`, so a section hidden at
render time was advertised to AI crawlers.

## What shipped

- `collectEntries` in `ai/generate.ts` skips an entry for which `isNoindexEntry(data, config.seo)`
  holds, before `exclude.where`. The entry also disappears from `all.md`, bundles and the manifest,
  and references to it are masked like any left-out target.
- `AIContentConfig` gains `exclude.noindex` (default `true`) and `seo` (`SeoFieldLocation`, the
  same option `generateContentSitemap` takes).
- Body `entry:` links resolve against the settled export set (see the folded P3).

## Not done, by decision

A navigation field holding plain URL strings into a hidden section can't be recognised
generically. No new hook was added: the README shows a `fieldTransforms` recipe that filters the
field, and `exclude.where` drops a whole entry.
