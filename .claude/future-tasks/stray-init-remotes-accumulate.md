# Dev-init temp remotes accumulate in the adopter's real repo config

## Priority: P3

Found incidentally on 2026-08-13 while working on the submit status gate (PR-8):
`git remote -v` in the CanopyCMS repo itself listed **three** stray remotes left
behind by past dev-mode inits.

## Problem

`GitManager.pushBranchToLocalRemote` (`packages/canopycms/src/git-manager.ts:626`)
adds a uniquely-named temporary remote to the **source repo** — the adopter's
actual working repo — to seed the simulated `remote.git`:

```
const tempRemoteName = `__canopycms_init_${Date.now()}__`
await sourceGit.addRemote(tempRemoteName, options.remotePath)
```

It does remove it in a `finally` (`:665-671`), but that cleanup:

- **swallows every error silently** (`catch {}` with an "ignore cleanup errors"
  comment), so a failed removal leaves debris with no signal at all; and
- **doesn't run on a hard kill** — Ctrl-C or a crash during dev init skips
  `finally` entirely.

Because each init picks a fresh `Date.now()`-suffixed name, nothing ever
reclaims an earlier leak: they accumulate one per failed init, forever.

Observed in this repo (two pointing at a path that still exists, one at a temp
dir that is long gone):

```
remote.__canopycms_init_1774743409818__.url  /var/folders/.../canopycms-branchws-ZCghyI/.canopy-dev/remote.git
remote.__canopycms_init_1780496142006__.url  /Users/jps/dev/safeinsights/canopycms/apps/example1/.canopy-dev/remote.git
remote.__canopycms_init_1780502184948__.url  /Users/jps/dev/safeinsights/canopycms/apps/example1/.canopy-dev/remote.git
```

## Why it matters

Low severity — these are inert for normal git use. But it is our code writing
persistent junk into a **user's own repo config** and never cleaning it up, and
a dangling remote pointing at a deleted temp dir makes `git remote prune --all`
and similar sweeps fail. It also makes `git remote -v` output confusing enough
to be mistaken for a missing `origin` (which is what happened here).

## Fix sketch

- Sweep at init: before adding a new one, remove any existing remote matching
  `^__canopycms_init_\d+__$`. Self-heals every past leak with no migration.
- Log (don't swallow) a cleanup failure, at least under the debug logger.
- Optional: prefer `git push <url>` directly over adding a named remote at all —
  simple-git supports a URL as the remote argument, which removes the need for
  the temp remote and its cleanup entirely. Check whether the subdirectory
  snapshot path (`commit-tree` + `push <commit>:refs/heads/<base>`) works that
  way before committing to it.

## Files

- `packages/canopycms/src/git-manager.ts:619-672` (`pushBranchToLocalRemote`)

## Related

- No dev-mode-workspace-hygiene task exists (checked 2026-08-13); this was the
  only inbound reference to it. If a general dev-workspace cleanup task is ever
  filed, this belongs under it.
