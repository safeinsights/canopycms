# [P2] A reference-style link opens the whole body as source

Found 2026-10-08 by the round-trip corpus test (adopter request 87b).

## The gap

MDXEditor has no import visitor for `linkReference`, `imageReference` or `definition` nodes, so a
body with `[text][ref]` and `[ref]: https://…` fails the import and MarkdownField opens it as
source. Nothing is lost, but hand-written markdown uses reference links often. Pinned by
`reference-link.md` in `ROUTED_TO_SOURCE` in `markdown-roundtrip-corpus.test.tsx`.

## Proposal

Resolve references to inline links at import only if the export can write them back as references;
otherwise keep routing to source and say so in the fallback notice. Check MDXEditor upstream first.
