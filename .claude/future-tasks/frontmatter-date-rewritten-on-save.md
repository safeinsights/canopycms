# [P2] A YAML date in md/mdx frontmatter may be rewritten as a timestamp on save

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
