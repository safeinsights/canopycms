# [P3] Markdown fields stored in frontmatter or YAML are saved as the editor's serialisation

Found 2026-10-08 while making markdown BODY saves source-preserving.

## The gap

`preserveMarkdownSource` (`utils/markdown-body-splice.ts`) keeps the on-disk text of every block an
edit left alone, but only for an md/mdx file's body. A `markdown`/`mdx` FIELD stored as a string in
frontmatter or a YAML entry goes through the same MDXEditor export, and the YAML splice replaces the
whole scalar with it: editing one sentence of a multi-paragraph field restyles every list and
emphasis marker in that string. New text follows Prettier's markers now
(`editor/fields/markdown-export-options.ts`); untouched blocks inside the string do not keep theirs.

## Proposal

Apply `preserveMarkdownSource` to markdown-typed field values on write, against the value on disk.
That needs the schema at the serialiser (`serializeYaml`/`serializeFrontmatter` are schema-blind
today), so it belongs at `ContentStore.write`, which has the fields.
