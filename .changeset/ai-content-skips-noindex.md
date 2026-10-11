---
'canopycms': minor
---

### AI content leaves out `noindex` entries — **behaviour change for `/ai` output**

<!-- migration
area: AI
action: `exclude.noindex: false`
row: `noindex` entries leave AI content
-->

**What changed.** AI content leaves out entries marked `noindex`, both from `generate-ai-content`
and from the `/ai` route, using the same predicate as the sitemap and robots metadata. An inline
body `entry:` link to an entry the export leaves out (by `exclude`, `noindex` or a failed render)
renders as its plain text, with no URL; any other form of the link points at `#`.

**To adopt.** To keep exporting `noindex` entries, set `exclude: { noindex: false }`. If your SEO
fields are nested or renamed, pass the AI config's `seo` the same object you pass
`createNextCanopyContext({ seo })`, so the sitemap and AI content read the flag from the same
place. A field that links to a hidden section by plain URL needs a field transform; the README
shows [the recipe](../README.md#ai-content-configuration).

**Now deletable.** An `exclude.where` that re-read the `noindex` flag by hand.
