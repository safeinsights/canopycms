---
priority: P3
adopters: BOTH
summary: >-
  docs/ux-guidelines.md now lists "Clear" as its own verb (resetting an optional object field to unset), but `EDITOR_ACTIONS` in editor/copy.ts has no entry for it, so ObjectField's button text is a literal
---
# Add "Clear" to `EDITOR_ACTIONS`

[Vocabulary](../../docs/ux-guidelines.md#vocabulary) keeps an optional object field's "Clear" as
its own verb: it resets the value to unset and deletes nothing. New UI takes its verbs from
`EDITOR_ACTIONS` in `packages/canopycms/src/editor/copy.ts`, which has `remove` but no `clear`.
Add `clear: 'Clear'` and use it for `ObjectField`'s `onRemove` button; `FormRenderer.tsx`'s
`case 'object'` comment can then point at the vocabulary instead of restating the reason.
