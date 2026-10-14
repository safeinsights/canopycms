---
priority: P3
adopters: NEITHER
summary: >-
  Two code follow-ups to JP's 2026-10-13 rulings: `lint:ux-copy` scans only `editor/`, so copy the editor shows from outside it, such as `ENTRY_CHANGED_MESSAGE` in `api/entries-constants.ts`, is never checked; and the group and permission managers show their 409 conflicts in red, where docs/ux-guidelines.md now rules conflicts yellow
---

# Copy lint scope, and conflicts shown in red

## Copy lint misses editor-visible constants outside `editor/`

`scripts/check-ux-copy.mjs` scans `packages/canopycms/src/editor` only (`SCOPE`).
`ENTRY_CHANGED_MESSAGE` in `packages/canopycms/src/api/entries-constants.ts` reaches the editor
unchecked. Done when the copy lint also checks every constant the editor shows from outside
`editor/`, and [Enforcement](../../docs/ux-guidelines.md#enforcement) says so.

## 409 conflicts in red

[Colour and contrast](../../docs/ux-guidelines.md#colour-and-contrast) rules a 409 conflict
yellow, since nothing is lost yet; `hooks/useDraftManager.ts` already does. `hooks/useGroupManager.ts`
and `hooks/usePermissionManager.ts` catch their `expectedContentVersion` 409 into a red toast.
Check the schema editor's saves too. A 409 that is not an edit conflict (a busy lock, the admin
branch-health repairs) needs its own look before it changes colour.
