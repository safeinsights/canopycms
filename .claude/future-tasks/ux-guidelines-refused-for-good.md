---
priority: P3
adopters: NEITHER
summary: >-
  New 2026-10-12. docs/ux-guidelines.md has no rule for a save the server refuses for good (an entry deleted since it was opened), where "offer Retry" cannot apply, nor for the colour of a save refused on conflict (every 409 in the editor is yellow). And `lint:ux-copy` scans only `editor/`, so copy the editor shows from `api/entries-constants.ts` is never checked
---

# UX guideline gaps found reviewing the deleted-entry save

## What is known

- "Errors … offer Retry" (Loading, empty and error states) does not fit a refusal no retry can
  pass. The deleted-entry save keeps the input and offers the deliberate alternative ("Save as new
  entry"); a rule could say so.
- The colour rule (red error, yellow warning) is silent on conflicts. Every 409 toast in
  `packages/canopycms/src/editor/hooks/useDraftManager.ts` is yellow, on the grounds that nothing
  is lost yet.
- `scripts/check-ux-copy.mjs` scans `packages/canopycms/src/editor` only; `ENTRY_CHANGED_MESSAGE`
  in `packages/canopycms/src/api/entries-constants.ts` reaches the editor unchecked.

## Done when

The guidelines state both rules, and the copy lint covers editor-visible constants outside
`editor/`.
