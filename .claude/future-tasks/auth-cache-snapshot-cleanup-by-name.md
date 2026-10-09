---
priority: P2
summary: >-
  New 2026-08-21, from the round-2 Fable review of the infra-review epic, which flagged it as **pre-existing** (the epic changed the symlink target, not this retention logic) — filed separately to keep that epic's diff honest. `cleanupOldSnapshots` keeps the 2 newest snapshots **by name**, i.e. by timestamp string, and never consults what `current` targets. A BACKWARDS clock step on the worker (an NTP correction, which long-lived EC2 instances do experience) makes the just-written `snapshot-<smaller-ts>` sort oldest, so cleanup deletes the directory `current` was just swapped to — leaving a dangling link and an EMPTY auth cache until the next refresh. Same user-visible symptom as the absolute-symlink defect this epic fixed (raw Clerk ids, Clerk-org ACLs denying), so if it ever fires it will look exactly like a regression of that fix. Self-heals in 15 minutes. Fix: resolve `current` and exclude its target from the deletion set, making "never delete the live snapshot" structural rather than a consequence of monotonic clocks
---
# [P2] `cleanupOldSnapshots` can delete the snapshot `current` points at

Found by the round-2 independent Fable review of `epic/infra-review-2026-08`
(2026-08-21), which flagged it explicitly as **pre-existing, not an epic
defect** — the epic changed only the symlink's target, not this retention
logic. Filed rather than folded into that epic to keep its diff honest.

## The defect

`auth/file-based-auth-cache.ts`'s `cleanupOldSnapshots` keeps the 2 most recent
snapshots **by name**:

```ts
const snapshots = entries.filter((e) => e.startsWith('snapshot-')).sort().reverse()
for (const snapshot of snapshots.slice(keepCount)) { /* rm -rf */ }
```

The name is `snapshot-${Date.now()}`, so "most recent" is really "largest
timestamp string", which is only the same thing while the clock moves forward.
It never consults what `current` actually targets.

## Failure scenario

The worker's clock steps **backwards** — an NTP correction after drift, which a
long-lived EC2 instance does experience. The refresh writes
`snapshot-<smaller-ts>/`, swaps `current` to it, then sorts: the just-written
directory now sorts *oldest*, falls outside `slice(2)`, and is deleted.

`current` is left dangling. `resolveActiveCacheDir` resolves it, the guard
passes (it is under the cache dir), and the reader then finds no
`users.json`/`orgs.json`/`memberships.json` there — `maxMtime` stays 0 and the
Lambda serves an **empty** auth cache until the next successful refresh: editors
render as raw Clerk ids and Clerk-org ACLs deny.

That is the same user-visible symptom as the absolute-symlink defect this epic
fixed ([resolved/infra-review-2026-08-auth-cache-symlink.md](resolved/infra-review-2026-08-auth-cache-symlink.md)),
which is why it is worth closing properly rather than leaving as a curiosity —
if it ever fires, it will look exactly like a regression of that fix.

Bounded: it self-heals on the next refresh (15 minutes), and only an in-memory
cache miss in that window is affected.

## Fix direction

Resolve `current` first and exclude its target from the deletion set, whatever
its name sorts as. That makes the invariant "never delete the live snapshot"
structural instead of a consequence of monotonic clocks. Sorting by directory
mtime rather than by parsed name is a weaker second option — it has the same
clock dependency.

Worth a test that writes a snapshot, forces a lower-timestamped one, and asserts
the reader still loads.
