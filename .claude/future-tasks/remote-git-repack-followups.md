---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-06, from review. `remote.git` repack follow-ups: sweep `objects/tmp_objdir-incoming-*` left by a killed push, measure repack cost (a full `repack -a` about every five pushes) and consider `--geometric`, a clone retry on a mid-read unlink doubles its time, and the worker's remote path must match the clones' `origin` for residue repair
---
# remote.git repack: leftovers, frequency, and the worker's remote path

## Priority: P3 [BOTH]

`remote.git` is kept packed by `git-manager.ts` `repackBareRemoteIfNeeded` (run each cycle by the
worker, and by dev's `ensureLocalSimulatedRemote`), with config from `REMOTE_GIT_CONFIG`. Object safety is covered: `--cruft` with no expiry drops
nothing, and hardlinked packs keep their inodes. Four smaller points were found in review and are
not yet handled.

## 1. `objects/tmp_objdir-incoming-*` leftovers

`receive-pack` writes a push into an `objects/tmp_objdir-incoming-*` quarantine directory before moving it
in. A Lambda killed mid-push leaves that directory behind. gc used to remove old ones; nothing
does now that gc never runs in `remote.git`.

**Fix:** have `repackBareRemoteIfNeeded` sweep `objects/tmp_objdir-incoming-*` directories older than an hour.

## 2. Repack frequency

`transfer.unpackLimit=1` makes every push a pack. With `REMOTE_GIT_MAX_PACKS = 6`, a full
`repack -a` of the whole repo runs about every five pushes, inside the worker's sync loop on a
t4g.nano.

**Fix:** measure the repack time on a deployment (the `remote.git maintenance: … in N ms` line).
If it matters, use `repack --geometric=2` for routine passes and keep a rare full repack.

## 3. Clone time when a pack is unlinked mid-read

A Lambda reading a pack that the worker (a different NFS client) unlinks mid-read can hit
ESTALE. The clone then retries once (`GitManager.cloneRepo`), which doubles clone time inside the
request. This is rare, but it is a 60 s budget.

## 4. The worker's remote path must match the clones' `origin`

`repairBranchDirResidue` classifies a directory as residue only if its `origin` resolves to the
worker's `remoteGitPath` (`branch-provisioning.ts` `sameRemote`).

With the CDK, the Lambda and the worker both mount EFS at `/mnt/efs`, so this holds. A
hand-rolled deployment that mounts EFS at a different path on the worker would classify all
residue as `foreign`, and the worker would never quarantine it. The Lambda-side quarantine still
works.

**Fix:** compare the path relative to the workspace root rather than the absolute path, or log
the mismatch once.
