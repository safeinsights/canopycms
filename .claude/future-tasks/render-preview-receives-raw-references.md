---
priority: P3
adopters: NEITHER
summary: >-
  New 2026-10-09. The editor's `renderPreview` prop is called with the raw form value, so references reach it as bare ids, while the default iframe preview receives them resolved. Decide whether it should get the resolved value and loading state too
---
# A custom `renderPreview` receives references as bare ids

**Status:** Open. **Priority: P3.** Filed 2026-10-09 while making the iframe preview resolve
references at every depth
([preview-reference-resolution-depth.md](resolved/preview-reference-resolution-depth.md)).

## State

`Editor.tsx` calls `renderPreview(currentEntry, effectiveValue)`. The default preview
(`PreviewFrame`) gets `previewValue` from `useReferenceResolution` instead, where every reference
is its target or `null`. An adopter passing `renderPreview` through `CanopyEditor` therefore sees
ids where the iframe preview sees entries. No adopter is known to use `renderPreview`.

## Options

1. Pass the resolved value (and `isLoading`) to `renderPreview`. That changes what an existing
   caller receives, so it needs a migration entry.
2. Document that `renderPreview` receives the raw form value, and leave the resolution to it.
