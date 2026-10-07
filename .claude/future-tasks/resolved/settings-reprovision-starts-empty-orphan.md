# A re-provisioned settings workspace starts as an empty orphan, and the next settings save fails

**Status:** RESOLVED 2026-10-05 on branch `fix/settings-reprovision-uses-remote-branch` (see
"Resolution" at the end). **Priority: P1 [BOTH].** Filed 2026-10-05. Found by the round-1 review of the
settings-ensure memo (its reviewer called it pre-existing and unrelated to the memo) and then
reproduced. Not caused by the memo: the full provisioning path behaves the same on every call.

## Problem

When the settings workspace directory is gone and `SettingsWorkspaceManager.ensureGitWorkspace`
provisions it again, the new workspace does **not** pick up the settings branch that already
exists on the remote:

1. `GitManager.cloneRepo` clones `--branch <base> --single-branch`
   (`packages/canopycms/src/git-manager.ts:307`), so the remote's settings branch is never fetched.
2. `createOrphanSettingsBranchInner` (`git-manager.ts:1340`) looks only at local branches, finds
   none named after the settings branch, and runs `checkout --orphan` + an empty "Initialize
   settings branch" commit.
3. The workspace now has no `groups.json` or `permissions.json`, so every request resolves users
   with **no internal groups and no path rules**. Bootstrap admins still work, and nothing errors,
   so this is silent.
4. The next settings save goes through `commitToSettingsBranch`, which pulls the current branch
   first (`services.ts:418`). The fetched remote settings branch shares no history with the new
   orphan, and the merge throws `fatal: refusing to merge unrelated histories`. That is not a
   `GitRemoteRefMissingError`, so the save returns `committed: false` with the error, **every
   time**, until someone repairs the workspace by hand.

The triggers are the ordinary ways a settings workspace disappears: an EFS volume replaced or
wiped, a new deployment pointed at a remote that already holds settings, and **the rename
guard's own recovery advice**. Its refusal message (`settings-workspace.ts:157`) tells the
operator to "move `<settingsRoot>` aside manually first", which is exactly this path.

## Reproduction (measured 2026-10-05, dev mode against a local bare remote)

Provision, write and commit `groups.local.json`, push the settings branch, move the workspace
aside, provision again in a fresh module graph, then pull. Observed:

```
remoteHasSettingsBranch: "canopycms-settings-probe"
groupsFilePresentAfterReprovision: false
currentBranch: "canopycms-settings-probe"
logAfterReprovision: "e4ddb12 Initialize settings branch"
pullAfterReprovision: "THREW GitError: fatal: refusing to merge unrelated histories"
```

Prod runs the same `initializeWorkspace` → `cloneRepo` → `createOrphanSettingsBranch` path, with
`remote.git` on EFS as the remote; this was not run against prod.

## Fix sketch (needs a design pass, not a quick patch)

In `createOrphanSettingsBranchInner`, before creating an orphan, ask the remote whether the
settings branch exists (`git ls-remote --heads <remote> <branch>`). If it does, fetch it and
check it out tracking the remote (`fetch <remote> <branch>:<branch>`, then `checkout <branch>`)
instead of creating an empty orphan. Only a genuinely new deployment, with no remote settings
branch, should get the empty orphan. Questions for the design pass:

- The worker pushes settings branches from `remote.git` to GitHub ([SYNC-M3] in
  docs/concurrency.md). Which remote is authoritative when the two disagree?
- Should the rename guard's message point at this behaviour once it exists (move aside, and the
  next provision restores from the remote), so the documented recovery is safe?
- Recovery for a workspace already in the broken state: an orphan holding only its init commit,
  next to a populated remote branch.

Tests: provision → save → push → move aside → provision again must restore the files and let the
next save pull and push. A brand-new deployment must still get an empty orphan.

## Related, minor

`ensureGitWorkspace` has one module-level in-flight lock (`settingsInitLock`) for every
(root, branch) pair, so a waiter for one pair can return success when another pair's init
finishes (`settings-workspace.ts:188`). Production resolves a single pair per process, so this
reaches only tests. The per-process memo records only the holder's pair, so a wrongly satisfied
waiter is never remembered and its next call runs the full path.

## Resolution

`GitManager.createOrphanSettingsBranch` asks the workspace remote (`ls-remote`) before anything
else, and its doc comment holds the rules. Answers to the design questions:

- **Where truth lives.** The workspace remote: `remote.git` in prod, which the worker clones
  from GitHub with every branch, fast-forwards from GitHub, and pushes back. The Lambda cannot
  provision before the worker creates it, so a re-provisioned workspace sees what `remote.git`
  holds: GitHub's settings branch as of the worker's clone, plus every save pushed into
  `remote.git` since. A save the worker had not yet mirrored is lost only if `remote.git` is
  lost too.
- **"None" versus "unreadable".** `ls-remote` exits 0 with no output only for a reachable remote
  without the ref, so no error string is parsed. Unreadable throws
  `SettingsRemoteUnreadableError`, mapped to `RemoteNotReadyError` (the 503) when prod's
  `remote.git` is missing. A local branch that already holds settings is served while the remote
  is unreadable; the next save surfaces the error.
- **Rename-guard advice.** The message now says the next start checks the branch out from the
  remote, or starts it empty when the remote has none.
- **Already-stuck workspaces.** An unrelated local branch still on its empty initial commit with
  a clean tree is reset onto the remote's under the init lock. Local commits or uncommitted files
  throw `SettingsBranchDivergedError` with the repair steps; local commits are never discarded.
  `GET /admin/status` carries the message as `settingsWorkspaceError`, shown in System Health.

The unrelated `settingsInitLock` waiter note above stays as written: it reaches only tests.

