---
adopters: BOTH
summary: >-
  RESOLVED 2026-10-09, branch `fix/ai-content-resolved-references`, base `chore/backlog-frontmatter`. AI content renders a reference field as `[title](url)` in every position (field, list, table cell, object, block, md frontmatter line) instead of the stored id, never inlining the target. A gone target renders as `(missing entry <id>)`; a target the export leaves out by `exclude` renders as `(unavailable entry <id>)` with no title, masked before any transform runs. `where` and transforms receive an `AIReferenceValue`. Each target is read once per run, through a memo that never outlives the run.
---

# AI content shows a reference field as the bare target id

**Status: RESOLVED 2026-10-09**, branch `fix/ai-content-resolved-references`.

## Problem

From the marketing site's request log: converting its articles' `author` and `reviewer` to
`reference` fields turned every `/ai/blog/*.md` byline from a name into a bare id. Both AI-content
passes read with `resolveReferences: false`, and the renderer printed the raw value, so the
AI-facing copy no longer said who wrote or reviewed an article.

## Why resolution was off

The README gave one reason: so a shared block's content is not copied into every page that
references it. It was not about ACLs (the AI passes run with no reader identity and export the
whole non-excluded tree) or cycles (resolution is one level deep).

## What shipped

- `ai/references.ts` resolves each reference with `traverseFields` and
  `ContentStore.resolveReferenceTarget`, which embeds no body. A missing target keeps its id as
  `{ id, unavailable: true, reason: 'missing' }`, marked as unavailable the way a
  `RestrictedReference` is.
- `generateAIContent` runs in two phases. It collects and filters every entry first, so the set
  of exported ids is known. Then it masks any reference to a target outside that set, runs the
  entry transforms, and renders.
- `json-to-markdown.ts` renders every reference through one `formatReference`: the page link,
  then a link labeled `markdown version` to the target's file in this export, under the AI
  config's `mountPath` (default `/ai`), so an AI reader can fetch the referenced entry's clean
  copy and tell it from the page. On md/mdx entries,
  object and block frontmatter fields render as sections; before, they printed as
  `[object Object]`, which hid any reference inside them.
- Regression test: `ai/__tests__/reference-app-ai-references.integration.test.ts`, run over
  `apps/example1`'s content.
