# [P3] Docs guard: verify heading anchors, not just file links

**Status:** Open. Filed 2026-09-14 from the docs-consolidation PR in
[baseline-quality-202609.md](baseline-quality-202609.md).

`scripts/check-docs.mjs` resolves a relative markdown link's **file** but ignores its `#anchor`,
so a link such as `ARCHITECTURE.md#core-mental-model` stays green after that heading is renamed or
deleted. The consolidation renamed or removed well over a hundred headings across the four root
docs and `docs/`, and the only thing that caught the resulting breakage was a throwaway script
run by hand.

## Fix shape

- In check 2, after the target file resolves, slugify every heading in it (GitHub's rule: lower
  case, strip punctuation other than `-` and space, each space to `-`, no collapsing, so
  `Asset & Media System` is `asset--media-system`) and fail when the fragment matches none.
- Same-file links (`(#anchor)`) count too; they are the majority of README's table of contents.
- Skip fenced code blocks when collecting headings and when scanning for links, as the existing
  extractor already does for word counts.
- Cache headings per file; the run is one pass over ~50 markdown files.

## Not in scope

- Anchors into `docs/reviews/` and `.claude/future-tasks/`, which the checker already excludes.
- External URLs with fragments.
