# Expire cruft objects in `remote.git`

## Priority: P3 [BOTH]

The worker repacks `remote.git` with `git repack -a -d --cruft` and **no expiry**
(`worker/remote-git-maintenance.ts`). Unreachable objects go into one cruft pack instead of being
deleted, so a Lambda push that depends on an old object is never broken by a concurrent repack.

The cost is that the cruft pack only grows. Every force-with-lease history rewrite leaves its
old commits there, which is harmless for a content repo for a long time.

When it matters, add an expiry long past any push's lifetime, for example
`--cruft-expiration=30.days.ago`, and run it rarely (weekly, not every cycle). Check first that no
branch clone borrows objects from `remote.git` through alternates. None does today: clones hardlink
packs, and a hardlinked pack keeps its inode when `remote.git` deletes its name.
