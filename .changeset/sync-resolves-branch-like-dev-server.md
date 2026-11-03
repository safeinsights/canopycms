---
'canopycms': patch
---

### `canopycms sync` reaches the workspace the dev server reads for a branch with a slash

<!-- migration
area: Branches
action: None
row: sync push/pull reach slash-named branches' workspaces
-->

**What changed.** `sync` resolves a branch name the way the dev server does. On a branch such as `fix/header`, `push` used to report success but write to a nested `.canopy-dev/content-branches/fix/header` that nothing reads, so the dev site never changed; it now writes to `fix-header`, the workspace the dev server serves, and `pull`, `both` and `abort` read from it. `--branch` also takes an editor branch's short name or its workspace directory name. `sync` refuses a workspace that belongs to a different branch, and a directory under `content-branches/` that is not its own git repository. Short names honour `branchNamespace` from `canopycms.config.ts`; if the config cannot be used, `sync` warns and uses the defaults.
