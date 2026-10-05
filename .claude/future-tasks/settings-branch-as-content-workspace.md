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

## Questions to settle

- Why is the settings branch in `shouldAutoCreate`? If no route legitimately reads the settings
  branch as content, drop it there.
- Should `runRebaseCycle` and the base refresh skip a reserved-prefix (or configured settings)
  directory explicitly?
- Can a non-admin reach this with a crafted `branch` parameter, and what would they then read?

## Interaction with re-provisioning from the remote (by reading, 2026-10-05)

Provisioning now treats the workspace remote's settings branch as the durable copy
([resolved/settings-reprovision-starts-empty-orphan.md](resolved/settings-reprovision-starts-empty-orphan.md)).
The auto-created workspace is a second, divergent copy: `checkoutBranch` creates the settings
name **from the base branch**, so it carries content history. Submitting it pushes that name to
the remote, which rejects it non-fast-forward when the real settings branch is there, but
accepts it when the deployment has never saved settings. After that:

- a settings workspace holding real settings fails closed with `SettingsBranchDivergedError`
  (loud, and shown in System Health);
- a never-saved settings workspace is on its empty initial commit, so provisioning adopts the
  content-history branch: still no groups or path rules, as before, but later settings saves
  commit onto content history and the worker mirrors it to GitHub.

The `handler.test.ts` describe "buildContext auto-create: settingsBranch must match …" pins the
current inclusion, so dropping it reverses a deliberate choice; settle the first question
above before changing it. This finding argues for dropping it.
