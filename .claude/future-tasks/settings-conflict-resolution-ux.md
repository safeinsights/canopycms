# Editor conflict-resolution UX for settings 409s

**Priority: P3** — the safety net exists; this is the ergonomics on top

## Background

The settings version-conflict flow was wired end-to-end on branch
`claude/settings-schema-protection-3b78af` (see
[resolved/settings-file-occ-cross-host.md](resolved/settings-file-occ-cross-host.md)):
GET `/permissions` and `/groups/internal` return the file `version`, the editor hooks
(`usePermissionManager`, `useGroupManager`) send it back as `expectedContentVersion`,
and a mismatch returns 409 whose message ("… modified by another user. Please reload
and try again.") surfaces through the existing red error notification.

Deliberately minimal by design: on a 409 the hooks do NOT auto-refresh the stored
version (that would let a user hit Save twice and silently overwrite the other
admin's edit). The user must close and reopen the manager to reload.

## Task

Design a real conflict experience for the permissions and groups managers:

- On 409, offer an explicit "Reload latest" action (refreshes data + version, discards
  local edits) instead of requiring close/reopen — but never a bare "retry" that
  resubmits stale edits over a fresh version.
- Consider showing what changed (diff of the incoming vs local permission/group lists)
  so the admin can re-apply their edit deliberately.
- Keep the no-silent-overwrite invariant: any path that bumps the stored version must
  also replace the on-screen data.

## Notes

- Hooks: `packages/canopycms/src/editor/hooks/usePermissionManager.ts`,
  `useGroupManager.ts` (each keeps a `versionRef` with a comment pointing here).
- Server messages/status contract: `api/permissions.ts`, `api/groups.ts`
  (`SettingsVersionConflictError` → 409 with the reload message,
  `SettingsFileConflictError` → 409 busy).
