# A request naming the settings branch provisions it as a content-branch workspace

**Status:** RESOLVED 2026-10-05 on branch `fix/settings-branch-not-content` (see "Resolution"
at the end). **Priority: raised to P1 [BOTH]**, from P2, once re-provisioning from the remote
made the outcome reachable. Found 2026-10-05 by the review of the settings-branch PR fix.
Absorbs B2 of [branch-namespace-validation-gaps.md](../branch-namespace-validation-gaps.md).

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
([settings-reprovision-starts-empty-orphan.md](settings-reprovision-starts-empty-orphan.md)).
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

## Resolution

**Reproduced before the fix** (dev mode, real HTTP handler and git, editor persona, never-saved
settings): `GET /<settings>/status` answered 200 and cloned a content workspace;
`POST /<settings>/submit` answered 200 and pushed a content-history `refs/heads/<settings>` to
the workspace remote; a cold-start settings provisioning then checked it out (settings root:
`README.md`, no groups or permissions). The worker's GitHub push of that branch was reasoned from
`task-runner.ts`, not run.

**Why the settings branch was in `shouldAutoCreate`:** it dates from the January 2026
groups/permissions overhaul, before settings had their own workspace. The `handler.test.ts`
describe pinned only the deployment-namespaced spelling of the name, and no current caller
resolves the settings branch through `getBranchContext`.

**Fix:**

- `isSettingsBranchName` (`paths/branch-name.ts`): reserved prefix or the configured name,
  compared sanitized.
- `http/handler.ts`: `ApiContext.getBranchContext` returns null for it (404), before even an
  existing workspace on disk is loaded; it left `shouldAutoCreate`.
- `paths/branch.ts` `resolveBranchPath` refuses the prefix, and
  `BranchWorkspaceManager.openOrCreateBranch` also refuses the configured name, so the content
  reader and AI paths cannot provision one either.
- `api/branch.ts` hides a leftover settings-named workspace from the branch list (creation
  already rejected the name).
- `worker/rebase.ts` `runRebaseCycle` skips it (warning); `refreshBaseBranchWorkspace` only
  touches the base clone.
- `git-manager.ts`: adopting a remote settings branch (both the fresh checkout and the
  empty-orphan repair) throws `SettingsBranchHasContentHistoryError` when its roots include the
  base branch's.

