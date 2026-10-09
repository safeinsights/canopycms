---
priority: P3
adopters: NEITHER
summary: >-
  Commit the differential test that checked the MDX code policy against real `@mdx-js/mdx` and
  React 18: random bodies the policy accepts are evaluated with every global trapped and rendered,
  and must touch no global and emit no unsafe HTML. It needs `@mdx-js/mdx` as a devDependency
---
# Commit the MDX policy's differential test

**Priority:** P3. **Filed:** 2026-10-09.

## What it is

`validation/markdown-safety.ts` decides what MDX may contain by reading the parse tree. Its unit
corpus pins each rule, but cannot show that the rules match what `@mdx-js/mdx` compiles and React
renders. A scratch harness did, during the PR that added the policy:

- Build bodies of one to three fragments, drawn at random from a list of safe and unsafe shapes:
  expressions, ESM, tags, attributes, links, GFM tables, footnotes, code spans.
- For each body the policy accepts, compile it with `@mdx-js/mdx` 3.1, with and without
  `remark-gfm`.
- Run it in a `node:vm` context whose global object is a Proxy that records every read.
- Render it with `react-dom/server` 18.3, using a components Proxy that stubs every component name.

It must record no global read and emit no `<script`, `<iframe`, `javascript:`, `srcdoc` or `on…=`.

The result over 20,000 bodies, at the policy the PR merged with: 2,960 accepted, 0 failures. Control cases showed the refused shapes
really do run code or emit unsafe HTML.

## To do

Add `@mdx-js/mdx` and `remark-gfm` as devDependencies of `packages/canopycms`, without bumping
optional peers; see the memory note on grafting a lockfile. Then commit the harness as a seeded
vitest test.
