# Warm spare clones so branch create skips the checkout

## Priority: P3 [BOTH]

After packing and a sparse cone, branch create's remaining cost is writing the checkout onto EFS.
EFS charges per file: about 10 ms per file operation from the worker and about 50–60 ms from the
Lambda, both measured on a deployed editor. The `provision … step=checkout` log line gives the real
number. If it is still too slow, the checkout can be done before anyone asks for it.

## Design

1. The worker keeps 1–2 ready clones, `content-branches/.spare-<rand>-<STAMP>`. Each is built
   exactly like a staged branch (`stageBranchWorkspace`: clone, sparse cone, checkout of the base
   branch) and is reset to the base branch's tip each cycle. Spares hold no user data, so a hard
   reset is safe.
2. Create claims a spare with `rename(.spare-x → .prov-…)`. The rename is atomic at the NFS server,
   so two claimers can never both win: the loser gets ENOENT and tries the next spare or builds
   inline as today.
3. On the claimed clone:
   - `git checkout -b <name>` on the same commit, which writes no files;
   - a fast-forward if the base branch moved since the spare's last reset;
   - write `branch.json`;
   - publish by rename, unchanged (`publishStaging`).
4. The worker replenishes spares, and its existing `.prov-*` sweep covers a claimer that died.

The expected create time is about 1 s at any repo size. Building inline stays the fallback, so a
worker outage only removes the speed-up. Dot-prefixed names keep spares out of the registry,
branch-health and the rebase loop.

## Related

- [branch-provisioning-async.md](branch-provisioning-async.md)
