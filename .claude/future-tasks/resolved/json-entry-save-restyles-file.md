---
priority: P2
adopters: BOTH
summary: >-
  RESOLVED 2026-10-09, branch `fix/save-fidelity-edited-blocks`, base `int-202610-b`. `utils/json-source-splice.ts` (`serializeJson`) splices changed values into the file's text with jsonc-parser's `modify`, in the file's indent and line ending, appending a key and removing one without re-rendering its neighbour, and writes `JSON.stringify(data, null, 2)` when the file is not a JSON object or the splice does not read back as the data.
---
# [P2] Saving a JSON entry re-prints the whole file in `JSON.stringify` style

**Status: RESOLVED 2026-10-09**, branch `fix/save-fidelity-edited-blocks`, as proposed, with `jsonc-parser` as a dependency. Two departures from its formatted `modify`, both because a formatted edit re-renders the neighbouring member: an appended key is rendered by hand when the object's `}` has its own line, and removals are unformatted, with the whitespace a first-member removal takes put back.

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
