---
'canopycms': minor
'canopycms-next': minor
---

### SEO field location moves into config; reference pickers mark hidden entries and take a sort order — **breaking: `createNextCanopyContext({ seo })` and `AIContentConfig.seo` are removed**

<!-- migration
area: Refs
action: Move seo into config
row: Set seo in config; sort and badge reference options
-->

**What changed.** `defineCanopyConfig` takes `seo: { group?, fields? }`, the one place every surface reads an entry's `noindex` flag: the sitemap and `entryToMetadata` that `createNextCanopyContext` returns, AI content and the editor's reference picker. A per-call `seo`/`group`/`fields` still overrides it. The free `generateContentSitemap` takes `seo` as an argument and refuses to run without it when the config sets one; `createNextCanopyContext` and the AI content config refuse a leftover `seo`. A reference picker now badges an entry hidden from search as "Hidden from search", and picking one adds a note naming the setting on that entry's form, since a page listing only indexed entries won't show it. A reference field takes `optionSort`: `'label'` (the default), `'collection'`, or `{ field, direction }`. Point `field` at an ISO date, since strings compare as text.

**To adopt.** Move `seo` from `createNextCanopyContext({ seo })` and from `defineAIContentConfig({ seo })` into `defineCanopyConfig({ seo })`. See [Sitemap and SEO Metadata](../README.md#sitemap-and-seo-metadata) and [How References Work in the Editor](../README.md#how-references-work-in-the-editor).

**Now deletable.** A shared `seo` constant passed separately to the Next context and the AI content config.
