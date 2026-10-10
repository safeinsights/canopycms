---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-10, from the editor UI epic's WS0. The epic's copy rule says "Remove" everywhere (C5), but an optional object field's "Clear" button is deliberately not "Remove": it resets the field to unset and must not read as deleting the field from the schema (FormRenderer's `case 'object'` comment). Decide the word before the WS4 copy pass changes it
---
# "Clear" or "Remove" on an optional object field

[ui-epic-202610.md](ui-epic-202610.md) C5 lists "Remove vs Clear" as an inconsistency to fix by
using "Remove" everywhere. The one "Clear" in the forms is `ObjectField`'s `onRemove` button:

- It resets an optional object to `undefined`, so a required child can't strand the object
  present but invalid.
- `FormRenderer.tsx` (`case 'object'`) records why it is not "Remove".
- List-item and block "Remove" delete an item. This button deletes the value, not a thing.

WS0 kept "Clear". WS4 (C5–C9) should choose one of:

- keep "Clear" and add it to `editor/copy.ts` as its own verb;
- or rename it to something like "Remove value" or "Reset", and update the comment and tests.
