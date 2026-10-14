---
priority: P3
adopters: NEITHER
summary: >-
  `lint:ux-copy` scans only `editor/`, so copy the editor shows from outside it, such as `ENTRY_CHANGED_MESSAGE` in `api/entries-constants.ts`, is never checked. JP 2026-10-13: the copy lint covers editor-visible constants outside `editor/` too
---

# Copy lint misses editor-visible constants outside `editor/`

`scripts/check-ux-copy.mjs` scans `packages/canopycms/src/editor` only (`SCOPE`).
`ENTRY_CHANGED_MESSAGE` in `packages/canopycms/src/api/entries-constants.ts` reaches the editor
unchecked.

## Done when

The copy lint also checks every constant the editor shows from outside `editor/`, and
[Enforcement](../../docs/ux-guidelines.md#enforcement) says so.
