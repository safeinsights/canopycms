# [P3] A CRLF md/mdx file's frontmatter is still rewritten on every save

Found 2026-10-07 while making YAML saves source-preserving (`utils/yaml-source-splice.ts`).

## The gap

`serializeYaml` now keeps a CRLF `.yaml` file's bytes, line endings included. `serializeFrontmatter`
does not manage the same for a CRLF `.md`/`.mdx` file, for two reasons that are both gray-matter's:

- `matter(raw, {})` slices `.matter` so that it ends in the `\r` of the line before the closing
  `---`. The splice treats that bare `\r` as a mixed line ending and falls back to `toString()`,
  so the whole frontmatter comes back LF and re-folded.
- `matter.stringify` always writes `---\n` delimiters, so even a perfect splice would sit between
  LF delimiters above a body that is still CRLF.

Today's behaviour is unchanged from before the splice: correct data, a whole-frontmatter diff on
the first save. No adopter content is known to be CRLF.

## Proposal

Detect a consistently CRLF file in `serializeFrontmatter`, splice the frontmatter with its
trailing `\r` stripped, and write the delimiters with the file's own line ending, instead of
handing the framing to `matter.stringify`. The body already keeps its CRLF: the body splice
(`utils/markdown-body-splice.ts`) writes new text in the body's own line endings.
