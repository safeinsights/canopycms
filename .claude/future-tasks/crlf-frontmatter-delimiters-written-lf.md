---
priority: P3
adopters: BOTH
summary: >-
  A save of a CRLF md/mdx file writes gray-matter's `---` delimiters and the frontmatter's last line with LF, leaving mixed line endings, and drops a leading BOM. Write the frontmatter block in the file's own line ending and keep the BOM
---
# [P3] A CRLF markdown file's frontmatter delimiters are saved with LF

## The gap

`serializeFrontmatter` (`utils/content-serialize.ts`) hands the reconciled YAML to
`matter.stringify`, which writes its delimiters and the newline after the frontmatter as `\n` and
drops a leading BOM. The frontmatter between them keeps the file's CRLF, as does the body, so an
unchanged save of a CRLF file changes two or three lines' endings only: the opening `---`, the
last frontmatter line and the closing `---`. A BOM is lost the same way.

## Proposal

When the existing file's frontmatter uses CRLF, write the delimiters and the newline after the
frontmatter as CRLF, and keep a leading BOM. Assert the whole output in the CRLF test in
`content-serialize.test.ts`, which checks only lines it contains.
