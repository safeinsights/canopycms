---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-10, from the editor UI epic's WS3b UX review. With the admin items gated, a non-admin's Settings menu holds only "Media library"; give media its own rail icon in the shell redesign (WS1) and hide the gear when it would be empty
---
# A one-item Settings menu for non-admins

`components/EditorSidebar.tsx`'s Settings menu now shows Manage Permissions, Manage Groups and
System health to admins only, so an editor or reviewer opens a menu holding just "Media
library". The shell redesign's activity rail (WS1 in ui-epic-202610.md) is the natural home
for media; once it has a rail icon, hide the Settings gear when its menu would be empty.
