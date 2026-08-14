# `permissions.listGroups` gained a settings-workspace dependency

Recorded 2026-08-12 alongside PR #186 (internal groups in the Permission
Manager picker). Not a defect — a deliberate design consequence worth being
written down before it surprises someone during an incident.

## The change in failure surface

`GET /groups` (`listGroupsHandler`, `packages/canopycms/src/api/permissions.ts`)
used to depend on exactly one thing: `ctx.authPlugin.listGroups()`. It now also
resolves the settings workspace (`getSettingsBranchContext` →
`services.getSettingsBranchRoot()`) and reads `groups.json` from it
(`loadGroupsFile`), so it can merge internal groups into the picker.

So an endpoint that previously failed only when the auth provider was
unreachable can now also fail on settings-root resolution or the underlying
filesystem — in prod, EFS.

## The deliberate choice

On a groups.json read failure the handler returns 500 rather than degrading to
an external-only list, and `handleListGroups` (editor hook) throws rather than
returning `[]`, so the Permission Manager renders its warning banner. The
reasoning is in-code at both sites: a silently incomplete picker is the exact
bug PR #186 existed to remove, and quietly dropping the internal half would
reintroduce it in a form nobody could see.

The middle ground NOT taken: return the external half plus an explicit
"internal groups unavailable" marker, letting an admin still grant external
groups during an EFS incident. That is strictly more code and more states to
reason about, and it was not justified by anything observed. It is the obvious
thing to revisit if EFS turns out to be flaky in practice.

## Why this is filed as P3, not higher

During an EFS incident most of Canopy is already degraded — the content store
lives there too — so this does not open a new class of outage, and it now fails
visibly rather than silently. The value here is operational: whoever debugs a
"no groups in the permission picker" report should look at settings-workspace
health, not just the auth provider. That is a runbook line, not a code change.

## Action

- Add to the prod failure-mode notes / runbooks (see [program-g-operational-readiness](program-g-operational-readiness.md)):
  **"Permission picker shows a group-load warning" → check settings-workspace
  and EFS health, not only the auth provider.**
- Revisit the degrade-with-marker option only if EFS proves unreliable in
  production.

## Related

- [production-readiness-program](production-readiness-program.md) — the launch program these failure modes feed.
- [permission-manager-internal-groups-unreachable](resolved/permission-manager-internal-groups-unreachable.md) (in `resolved/`) — the fix
  that introduced this coupling, with the full decision record.
