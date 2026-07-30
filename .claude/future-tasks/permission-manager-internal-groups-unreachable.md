# Permission Manager's "Add Groups" picker can't reach internal groups

Confirmed while writing `apps/test-app/e2e/tests/permissions-groups.spec.ts`
(D1/D2 coverage, 2026-07-30).

## Problem

Path permissions and internal groups are two features that look like they
should compose, but the UI never connects them:

- **Group Manager** ("Manage Groups") creates/edits groups in
  `groups.json` — reserved (`Admins`/`Editors`/`Reviewers`) and custom
  ones. `authResultToCanopyUser` (`packages/canopycms/src/user.ts`) merges
  these into `user.groups` alongside the auth provider's external groups,
  and `checkPathPermission`
  (`packages/canopycms/src/authorization/path.ts`) checks
  `target.allowedGroups` against that same merged list — so an internal
  group ID is just as valid a permission target as an external one.
- **Permission Manager**'s "Add Groups" search (`GroupSelector.tsx`,
  wired through `PermissionEditor`/`PermissionManager`) is fed exclusively
  by `onListGroups` → `apiClient.permissions.listGroups()` →
  `ctx.authPlugin.listGroups()` (`api/permissions.ts`'s `listGroupsHandler`).
  That calls the AUTH PLUGIN's `listGroups()` — in dev mode, the static
  `DEFAULT_GROUPS` config (`team-a`/`team-b`/`team-c`,
  `canopycms-auth-dev/src/dev-defaults.ts`). It never reads `groups.json`.

Net effect: a user creates an internal group in Manage Groups, then opens
Manage Permissions to assign it to a path — and it's simply not in the
search results. The only way to grant an internal group a path permission
today is by hand-editing `permissions.json`'s `allowedGroups` array outside
the UI.

## Fix

`listGroupsHandler` (or a new endpoint) should merge `deriveInternalGroups`
(already used by `groups.ts`) with `ctx.authPlugin.listGroups()`, so the
Permission Manager's picker offers both universes. Consider disambiguating
the two sources in the picker UI (e.g. a small "Internal"/"External" tag
next to each option) since IDs from the two sources aren't namespaced
against each other.

## Files

- `packages/canopycms/src/api/permissions.ts` (`listGroupsHandler`)
- `packages/canopycms/src/editor/permission-manager/hooks/useGroupsAndUsers.ts`,
  `GroupSelector.tsx`
- `packages/canopycms/src/user.ts` (`authResultToCanopyUser` — confirms internal
  groups ARE valid `allowedGroups` targets, so this is a real reachability
  gap, not a "different concept" by design)
