---
priority: P2
adopters: BOTH
summary: >-
  New 2026-10-08, measured. A `.json` entry is saved as `JSON.stringify(data, null, 2)`, which puts a short array one element per line where Prettier keeps it on one, so the first save of a Prettier-formatted JSON entry with a short array fails an adopter's `prettier --check` on untouched lines. Splice changed values into the file's text, as YAML saves do
---
# [P2] Saving a JSON entry re-prints the whole file in `JSON.stringify` style

Found 2026-10-08 while making markdown body saves source-preserving. Measured with Prettier 3.8.1.

## The gap

`ContentStore.write` writes a `.json` entry as `JSON.stringify(data, null, 2)`, whatever the file
looked like. Prettier keeps a short array on one line (`"tags": ["a", "b"]`) where `JSON.stringify`
puts each element on its own line, so the first save of a Prettier-formatted JSON entry that holds a
short array fails an adopter's `prettier --check`, on lines the editor never touched. YAML entries
and md/mdx frontmatter already splice into the file's own text (`utils/yaml-source-splice.ts`);
JSON is the one entry format that does not.

## Proposal

Splice changed values into the file's own text, as the YAML path does: parse with positions (for
example `jsonc-parser`'s `modify`/`applyEdits`, which edit a JSON document in place), write only
the changed values, and fall back to `JSON.stringify` when the result does not parse back to
`data`. Keep the trailing newline and the file's indentation.
