---
priority: P2
adopters: BOTH
summary: >-
  Ship a non-executing MDX renderer (mdast → React with no evaluater, the safe-tag and URL rules
  of `validation/markdown-safety.ts`, and the site's components map), so a preview is safe by
  construction even for content that never passed a CMS save. Build it with the component registry
---
# A non-executing MDX renderer for previews

**Priority:** P2 [BOTH]. **Filed:** 2026-10-09, deferred by JP from the MDX trust-model decision.

## Why

The save-time policy ([resolved/mdx-preview-executes-editor-code.md](resolved/mdx-preview-executes-editor-code.md))
keeps code out of every field that is not `executable`. It cannot cover content that never passed
a CMS save: content committed outside the CMS, or saved before an adopter upgraded. A renderer
that cannot evaluate anything closes that for previews by construction.

## Proposal

`renderMdx(body, { components })`: parse with `micromark-extension-mdxjs`, convert with
`mdast-util-to-hast` (passing MDX JSX nodes through), render with `hast-util-to-jsx-runtime` and
**no** `createEvaluater`, so an expression cannot render. Reuse `markdown-safety.ts`'s tag
allowlist and URL rule. A violation renders a placeholder and calls `reportError`.

## Open questions

- **Placement.** `canopycms/preview` if it tree-shakes. The parser adds acorn and micromark to any
  page that imports it. Otherwise a new `canopycms/mdx` subpath, which needs JP's approval.
- **Preview/production parity.** A site rendering production with `evaluate` and remark/rehype
  plugins sees a different preview. Decide whether the renderer accepts unified plugins.
- **Allowlist source.** The component list is
  [mdx-registered-components.md](mdx-registered-components.md)'s registry. Design them together.
- Using it in `apps/example1` is a new example↔package touchpoint, which needs approval.
