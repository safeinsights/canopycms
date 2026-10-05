# A request naming the settings branch provisions it as a content-branch workspace

## Priority: P2 [BOTH] — investigate first; it may be intended

Found 2026-10-05 by the review of the settings-branch PR fix; confirmed by reading, not run.

## What the code does

- `http/handler.ts` (`getBranchContext`, the `shouldAutoCreate` condition) auto-creates a
  content-branch workspace under `content-branches/` when the requested branch is the base, the
  active branch, **or the settings branch**.
- `worker/rebase.ts` has no settings-branch exclusion, so once such a workspace exists the rebase
  loop treats the orphan settings branch like any editing branch.

So an editor request whose `branch` parameter names the settings branch can make the worker try
to rebase an orphan branch onto the base. Branch creation (`api/branch.ts`) rejects the reserved
`canopycms-settings-` prefix, but this path is provisioning by name, not creation.

## Who can submit the shadow clone

The auto-created workspace is `canopycms-system`-created and unprotected, so
`authorization/branch.ts:155-162`'s `isSystemBranch && accessResult.allowed` arm makes it
**submittable by anyone with branch access**, which under a scaffolded `defaultBranchAccess: 'allow'`
is every authenticated user. Outside the pre-first-push window the submit 409s, but the clone exists
and shows up in admin listings. `http/handler.ts:72-74` (`shouldAutoCreate`) bypasses
`createBranchHandler`'s explicit rejection of the settings namespace (`api/branch.ts:233-256`).

**Fix:** drop `branch === settingsBranch` from `shouldAutoCreate` (settings has its own path via
`getSettingsBranchRoot`), and/or refuse `RESERVED_SETTINGS_BRANCH_PREFIX` in the workflow guards,
and make `runRebaseCycle` and the base refresh skip a reserved-prefix directory.

## Questions to settle

- Why is the settings branch in `shouldAutoCreate`? If no route legitimately reads the settings
  branch as content, drop it there.
- Should `runRebaseCycle` and the base refresh skip a reserved-prefix (or configured settings)
  directory explicitly?
- Can a non-admin reach this with a crafted `branch` parameter, and what would they then read?
