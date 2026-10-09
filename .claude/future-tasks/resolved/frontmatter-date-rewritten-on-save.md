---
priority: P2
adopters: BOTH
summary: >-
  RESOLVED 2026-10-09, branch `fix/save-fidelity-edited-blocks`, base `int-202610-b`. Confirmed end to end: the read path's js-yaml (YAML 1.1) reads `date: 2024-01-15` as a Date, the API carries it as a timestamp, the editor sends it back untouched, and the reconciler compared against `yaml`'s YAML 1.2 reading, so every md/mdx save rewrote the line (and `014` as `12`). `serializeFrontmatter` now reconciles a value sent back unchanged from the read as the disk's own value, and keeps a reconciled file only if gray-matter reads `data` back from it, else gray-matter writes it.
---
# [P2] A YAML date in md/mdx frontmatter may be rewritten as a timestamp on save

**Status: RESOLVED 2026-10-09**, branch `fix/save-fidelity-edited-blocks`. A value the editor sends back as gray-matter read it keeps its text; a changed value is written, and one whose new text the two YAML parsers would read differently (a date-like string, `014` set to 14) falls back to gray-matter's own output. Pinned in `utils/content-serialize.test.ts`, through `ContentStore` in `content-store.test.ts`, and by `frontmatter-date.md` in the corpus.

Found 2026-10-08 by a reviewer of the round-trip corpus test (adopter request 87b). Reproduced at
`serializeFrontmatter` only; not yet checked end to end through the editor's form state.

## The gap

gray-matter (js-yaml) reads `date: 2024-01-15` as a `Date`, which the API's JSON carries to the
editor as the string `2024-01-15T00:00:00.000Z`. The frontmatter reconciler
(`utils/content-serialize.ts`) reads the on-disk scalar with the `yaml` library as the string
`2024-01-15`, sees a different value, and writes `date: 2024-01-15T00:00:00.000Z`. Feeding that
data to `serializeFrontmatter` with the original file rewrites the line; whether the editor sends
it unchanged (or a date field normalises it) is the open question. If it does, any save of a dated
post changes its date's text and the type a site's build reads.

## Proposal

Confirm with an entry carrying a date through the editor's save. If it reproduces, have the
reconciler treat an ISO timestamp at midnight UTC as equal to an on-disk date-only scalar, or keep
frontmatter values untouched by fields the save did not change. Add a dated fixture to
`editor/fields/__fixtures__/markdown-corpus` once fixed.
