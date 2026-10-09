---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-06. The preview pane shows its no-preview state only for entries an adopter marks `previewBase: false`; any other entry without a page frames the host's 404. The preview route already knows which entry types have no view, and could tell the editor over the bridge, which would remove the config step
---
# The editor cannot tell on its own that an entry has no page

**Status:** Open. **Priority: P3** — the explicit opt-out works; this removes a config step.

## What

The preview pane shows "No preview for this entry." only for entries an adopter marks with an
`editor.previewBase` value of `false`. Every other entry without a page frames its own `urlPath`,
which the host answers with its 404 page. No draft reaches another entry's page either way, since
the framed page's path never matches.

The core has no notion of "routable": which entries have a page is decided in adopter code (the
static-params `filter`, the sitemap `exclude`, and, for a `previewPrefix` site, the entry types
missing from `createPreviewPage({ views })`).

## Options

1. For a `createPreviewPage` site, have the preview route answer an entry whose type has no view
   with a page that posts a new bridge message (e.g. `canopycms:preview:unavailable`) to the
   editor, which then shows the no-preview state. The bridge's message names are a public
   contract (`editor/AGENTS.md`), and the route currently 404s that case on purpose, so this
   wants its own design pass.
2. Accept the 404 page as the honest default and keep `false` as the opt-out.

## Related

- `packages/canopycms/src/editor/editor-utils.ts` `buildPreviewRoute` — where `false` is read.
- `packages/canopycms-next/src/preview-page.tsx` — the no-view 404.
