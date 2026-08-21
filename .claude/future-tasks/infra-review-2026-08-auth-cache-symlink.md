# [P1] Auth cache is permanently empty on the prod Lambda — absolute `current` symlink target

Found by the 2026-08-20 three-round infrastructure review (round 3), at HEAD
`7881e489`. **CONFIRMED**, and the highest-certainty item in that review: it
fires on 100% of prod deploys with Clerk auth, which is the KB's shape.

## The defect

`writeAuthCacheSnapshot` records the `current` symlink with an **absolute**
target (`auth/file-based-auth-cache.ts:246` — `fs.symlink(snapshotDir, tmpLink)`,
where `snapshotDir = path.join(cachePath, 'snapshot-<ts>')`).

The two hosts reach the same EFS directory through different mount paths:

| Host   | Env                                              | Its view of the cache dir |
| ------ | ------------------------------------------------ | ------------------------- |
| Worker | `CANOPYCMS_WORKSPACE_ROOT=/mnt/efs/workspace` (`cms-service.ts:624`) | `/mnt/efs/workspace/.cache` (`canopycms-cdk/worker/index.ts:87`) |
| Lambda | `CANOPY_AUTH_CACHE_PATH=/mnt/efs/.cache` (`cms-service.ts:481`)      | `/mnt/efs/.cache` (via the `/workspace` access point) |

So the worker writes the target string `/mnt/efs/workspace/.cache/snapshot-<ts>`.
The Lambda reads that string verbatim, but in the Lambda's namespace `/mnt/efs`
**already is** EFS:`/workspace` — so the path denotes the nonexistent
EFS:`/workspace/workspace/.cache/…`. `resolveActiveCacheDir`'s escape guard
(`:40-64`) then correctly refuses it (the target is not under `/mnt/efs/.cache/`)
and falls back to the flat layout at `/mnt/efs/.cache` — where the worker never
writes anything, because it only ever writes snapshot directories. `maxMtime`
is 0, and the Lambda serves a permanently empty `FileBasedAuthCache`.

## Failure scenario

The KB deploys with Clerk. The worker's 15-minute `refreshClerkCache` runs
correctly, writing `snapshot-<ts>/` and swapping `current`. Every CMS Lambda
request still gets an empty cache:

- `getUser()` → null: every editor renders as a raw `user_...` Clerk id, no
  name, email or avatar anywhere in the UI
- `getUserExternalGroups()` → `[]`: Clerk-org group membership never applies, so
  every path/branch ACL granted to a Clerk org **silently denies**
- `listGroups()` / `searchUsers()` → `[]`: the admin permission-assignment UI
  cannot find any user or org to grant access to

Bootstrap-admin env IDs and Canopy-internal `.canopycms/groups.json` groups
bypass the cache and still work, so the deployment is degraded rather than
bricked, and it fails **closed** — hence P1, not P0. The 15-minute refresh loop
doing pure waste in this topology is the tell that this is unnoticed rather than
accepted.

## Why two review rounds and the test suite missed it

Round 2 verified the cache **directory roots** on both hosts resolve to the same
EFS directory — true, and exactly what the CDK test asserts
(`cms-deploy.test.ts:383-416`, "Lambda and worker resolve the same EFS
directory"). Nobody checked the symlink target stored *inside* that directory.

`file-based-auth-cache.test.ts` writes and reads within one `tmpDir` — a single
mount namespace, where an absolute target always resolves. Worse, its "symlink
target escapes cache directory" case (`:214-225`) asserts the escape-fallback
works; that same fallback is what fires on every prod Lambda read. Dev mode
never trips it either, since writer and reader share one process.

## Fix direction

Write the `current` symlink with a **relative** target:
`fs.symlink(path.basename(snapshotDir), tmpLink)`. The reader already resolves
relative targets against its own `cachePath` (`path.resolve(cachePath, target)`),
so a relative link resolves correctly from either host's namespace, and the
escape guard still catches a genuinely-escaping absolute link.

Add a cross-namespace regression test: write with `cachePath` A, then read the
same on-disk directory through a different `cachePath` B. That is the shape no
existing test has.
