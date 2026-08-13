# Permission Manager's "Add Groups" picker can't reach internal groups

RESOLVED 2026-08-12 on `fix/internal-groups-in-permission-picker`.
`listGroupsHandler` now merges `deriveInternalGroups` with
`authPlugin.listGroups()`, and each option carries a `source:
'internal' | 'external'` tag rendered beside its name in the picker.

Decisions taken while fixing it:

- **Names only.** Internal options expose `id`/`name`/`description` and
  deliberately drop `members`/`memberCount`. `permissions.listGroups` is
  guarded `privileged` (admin OR reviewer) whereas `groups.getInternal` is
  admin-only, so member identities and counts must not ride along. Reviewers
  can reach this drawer — the "Manage Permissions" menu item is not
  isAdmin()-gated, unlike "System health".
- **Collisions collapse, internal wins.** The two ID spaces are not namespaced
  against each other, but `checkPathPermission` matches one flattened
  `user.groups` list by ID string, so a shared ID *is* a single permission
  target; emitting two options would misrepresent enforcement.
- **Fails loudly.** A groups.json read failure returns 500 rather than
  degrading to an external-only list — a silently incomplete picker is the
  exact failure this fix removes.

Regression cover: `packages/canopycms/src/api/internal-groups-in-permission-picker.test.ts`
(create via the groups API, read back through the picker endpoint), plus cases
in `api/permissions.test.ts` and `editor/PermissionManager.test.tsx`.

---

Original report, confirmed while writing
`apps/test-app/e2e/tests/permissions-groups.spec.ts` (D1/D2 coverage,
2026-07-30):

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
