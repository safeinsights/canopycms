---
priority: P3
summary: >-
  With a tag outside a field's `mdxAllow.htmlTags`, pasting or dropping rich text still writes it: `<u>`, `<sub>` and `<sup>` arrive as text formats, and a sized `<img>` as an image node MDXEditor exports as `<img width=…>`. The save refuses it, naming the tag and line. The toolbar's actions and shortcuts already cannot add one; a paste-scoped fix would close the rest.
---
# Pasting rich text writes a tag the field refuses

**Priority:** P3. **Found:** 2026-10-09, building and reviewing request 101's editor toolbar trim.

## Problem

When a field's effective `mdxAllow.htmlTags` leaves out a tag, `MarkdownField` hides the toolbar
actions that write it, turns off image resize, and its `tagFormatGuardPlugin` refuses
`FORMAT_TEXT_COMMAND`/`SET_TEXT_FORMAT_COMMAND` adding underline, subscript or superscript. Paste
and drop take another path: Lexical's `$insertDataTransferForRichText` sets those formats from
`<u>`/`<sub>`/`<sup>` and from `text-decoration`/`vertical-align` styles, and MDXEditor's image
node serializes as `<img>` when it has a width, height or other attribute. The save then refuses
the tag with a clear message, and the author can remove an underline with Cmd+U, or any of them in
source mode. So this is a confusing round trip, not a hole.

## Fix

Strip the refused formats and image sizes from nodes a paste or drop creates, and only those: an
earlier version stripped them with a `TextNode` transform, which also rewrote stored content on
opening an entry and marked it modified. A `PASTE_COMMAND` /
`CONTROLLED_TEXT_INSERTION_COMMAND` listener (CRITICAL, returning false) can flag the update a
paste runs in, for a transform to act on only while flagged, in the root and the active nested
editor. Test it beside `editor/fields/markdown-field-allowlist.test.tsx`'s guard tests, including
that opening an entry holding the tag reports no change.
