# [P2] Two latent proper-lockfile hazards found while adding the content-write lock

Both surfaced while implementing [SYNC-C1]
(`packages/canopycms/src/utils/content-write-lock.ts`). Neither is caused by that change; the
new lock was designed around them, and they remain for the existing callers.

## 1. Provisioning locks for different branches share one in-process registry key

proper-lockfile keys its module-level `locks{}` bookkeeping (refresh timer, release function)
by the **target path** passed to `lock()`, not by `lockfilePath`
(`node_modules/proper-lockfile/lib/lockfile.js`: `const lock = locks[file] = {...}`).

`acquireProvisioningLock(path.dirname(branchRoot), '.<branch>.init.lock')`
(`branch-workspace.ts:71`, `api/admin-branch-health.ts:245`/`:362`) therefore passes the SAME
target — the shared content-branches directory — for every branch. Two provisioning locks
held concurrently in one process (a Lambda container provisioning two branches, or purge +
provisioning) alias: the second acquisition overwrites the first's registry entry, so the
first's refresh timer and release function operate on the wrong lock object. The on-disk
locks are still distinct, so this is an in-process bookkeeping bug, not a mutual-exclusion
one — but it can strand or prematurely release a lock.

`withOccFileLock` already documents and avoids this (it locks the FILE, not its directory),
and the content-write lock anchors on `{branchRoot}/.canopy-meta` for the same reason.
So does the settings-workspace init lock added 2026-08-13 (baseline review B2), which
anchors on `{workspaceRoot}/.settings-init`: the obvious `path.dirname(settingsRoot)` is
`{workspaceRoot}`, exactly the target `ensureLocalSimulatedRemote` passes for
`.remote-init.lock` — and settings init calls into that while holding its own lock, so
anchoring there would have produced two live aliasing locks in one process.

**Fix direction:** give `acquireProvisioningLock` a per-branch target (e.g. the branch root
itself, or a per-branch subdirectory) so the registry key is unique, and check the
`branch-health.ts` [H1] freshness rail, which stats the lock path by name.

## 2. A compromised lock throws from a timer and can take the process down

proper-lockfile's default `onCompromised` is `(err) => { throw err }`, called from inside the
refresh timer's callback — i.e. an uncaught exception, and there is no
`process.on('uncaughtException')` handler in the worker. It fires when the lock directory
disappears or its mtime stops matching, which on EFS is not far-fetched (attribute cache,
foreign takeover of a lock wrongly judged stale).

Exposure grows with hold duration: `GitManager`'s clone-time provisioning lock, the rebase
loop's content-write lock, and (since 2026-08-13) the settings-workspace init lock are all
held for many seconds to minutes.

**OBSERVED 2026-08-14 — this is no longer theoretical.** A full `pnpm -r run test` run
crashed with an `ECOMPROMISED` "Unhandled Errors" block and exit 1, from `onCompromised`
firing in an integration test under full-suite parallel load. Three subsequent runs (one
isolated, two full-suite) were clean with identical pass counts, so it is load-dependent
and non-deterministic — but it means the timer-throw path fires on an ordinary developer
machine, with no EFS and no cross-host contention. Two consequences worth carrying into
the fix: the failure surfaces as a **process-level crash separate from the pass/fail
tally**, so any pipeline that reads only pass counts (or pipes the run through `tail`)
reports a green suite for a crashed run; and if it fires this readily locally, the EFS
hold-duration argument above understates the production exposure rather than overstating
it.

**Fix direction:** pass an `onCompromised` that logs (`workerLogError` / `canopyLogError`) and
lets the holder finish, rather than throwing from a timer; decide per call site whether the
in-flight operation should also be aborted. Would need an options passthrough on
`provisioning-lock.ts`'s two helpers.
