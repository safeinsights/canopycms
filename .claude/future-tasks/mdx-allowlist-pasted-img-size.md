---
priority: P3
summary: >-
  With `img` outside a field's `mdxAllow.htmlTags`, pasting HTML that holds a sized `<img>` still gives MDXEditor an image node it exports as `<img width=…>`, which the save then refuses. The toolbar's resize is already off; an image node transform clearing width, height and extra attributes would close the paste path too.
---
# A pasted sized image writes an `<img>` the field refuses

**Priority:** P3. **Found:** 2026-10-09, building request 101's editor toolbar trim.

## Problem

When a field's effective `mdxAllow.htmlTags` leaves out `img`, `MarkdownField` passes
`disableImageResize` so the toolbar cannot size an image. But MDXEditor's image node serializes as
an HTML `<img>` whenever it has a width, height or any attribute beyond `src`, `alt` and `title`
(`shouldBeSerializedAsElement`), and pasting HTML with `<img width="300">` creates such a node. The
save then refuses `<img>` with a clear message, so this is a confusing round trip, not a hole.

## Fix

In `editor/fields/MarkdownField.tsx`, beside `tagFormatGuardPlugin`, register a node transform on
MDXEditor's `ImageNode` (from the `mdx` module, not a separate `lexical` import) that clears width,
height and extra attributes when `img` is refused. Test it like
`editor/fields/markdown-field-allowlist.test.tsx` does for underline.
