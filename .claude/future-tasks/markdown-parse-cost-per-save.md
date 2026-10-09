---
priority: P3
adopters: NEITHER
summary: >-
  A crafted markdown body (hundreds of levels of nested list, 250KB) takes about 25s to parse.
  Saves accept up to 2MB, and parse each md/mdx body several times: the source-preserving splice,
  and the code policy, run twice and again over the stored body. An authenticated editor can stall
  a single-process CMS. Bound the work per save
---
# Bound the markdown parse work one save can cause

**Priority:** P3. **Filed:** 2026-10-09, from the MDX trust-model PR's code review.

## Problem

`micromark` is super-linear on some shapes. A 250KB body of about 500 nested list levels took
24.6s in one `findUnsafeMarkdown` call; a 100KB body of plain prose or of simple components took about 0.18s on a developer laptop.

A save parses the body in two places, and the CMS caps a save's body at 2MB
(`MAX_CONTENT_BODY_CHARS` in `api/content.ts`):

- `utils/markdown-body-splice.ts`: the editor's body and the disk body.
- `validation/markdown-safety.ts`: each body with and without GFM, and the stored body too when
  the new one has issues.

Lambda's timeout bounds the damage there. A long-running server process, such as dev or a
single-server deployment, blocks its event loop for every user.

## Options

- Cap nesting depth or body size for md/mdx far below 2MB, refusing larger bodies with a clear
  message.
- Parse once and share the tree between the splice and the policy (the GFM and plain parses stay
  separate).
- Run the parse in a worker thread with a time budget, refusing the save when it runs out.
