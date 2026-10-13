---
priority: P3
adopters: BOTH
summary: >-
  RESOLVED (2026-10-13) — `EDITOR_ACTIONS.clear` exists and ObjectField's gray Clear button uses it; FormRenderer's `case 'object'` comment points at the vocabulary
---
# Add "Clear" to `EDITOR_ACTIONS`

## Status: RESOLVED 2026-10-13

[Vocabulary](../../../docs/ux-guidelines.md#vocabulary) keeps an optional object field's "Clear" as
its own verb: it resets the value to unset and deletes nothing. New UI takes its verbs from
`EDITOR_ACTIONS` in `packages/canopycms/src/editor/copy.ts`, which has `remove` but no `clear`.
Add `clear: 'Clear'` and use it for `ObjectField`'s `onRemove` button; `FormRenderer.tsx`'s
`case 'object'` comment can then point at the vocabulary instead of restating the reason.
