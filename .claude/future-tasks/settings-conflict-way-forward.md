---
priority: P3
adopters: BOTH
summary: >-
  A groups or permissions version conflict shows yellow but says "Please reload and try again" with no reload control in the drawer, and reopening to reload drops the staged edits the yellow says aren't lost; the same message is also toasted beside the inline alert
---

# Settings version conflict: offer the way forward

Found by the UX review of the batch 3 behaviour PR. On a `SETTINGS_CHANGED` 409, the group and
permission managers show "Groups were modified by another user. Please reload and try again." in
a yellow "Not saved" alert (`group-manager/index.tsx`, `permission-manager/index.tsx`) and a
yellow toast (`hooks/useGroupManager.ts`, `hooks/usePermissionManager.ts`).

- **No way forward.** The drawer has no Reload, and reopening it reloads the file and drops the
  staged changes. [Loading, empty and error states](../../docs/ux-guidelines.md#loading-empty-and-error-states)
  asks a refusal no retry can pass to offer the deliberate alternative: for example a "Reload
  groups" action that re-fetches and re-applies the staged edits, saying which of them conflict.
  The server's message (`api/groups.ts`, `api/permissions.ts`) then names that action.
- **Toast and alert say the same thing.** "Don't toast what is already visible"
  ([Choosing a surface](../../docs/ux-guidelines.md#choosing-a-surface)): the hooks' failure toasts
  repeat every inline alert, conflict or not.
