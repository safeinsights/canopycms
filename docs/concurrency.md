# Concurrency in CanopyCMS

How CanopyCMS keeps shared mutable state correct when several processes — and several
hosts — operate on the same files at once. Read this before adding any cache, any
mutable JSON file, or any code that does read-modify-write against the workspace.

**Maintenance note:** this document is load-bearing. If you change locking, caching,
invalidation, or anything that touches `.canopy-meta/`, update this document in the
same change (the `docs-architecture` agent is chartered to check it).

## The deployment shape that drives everything

Production is a Lambda (API) plus an EC2 worker sharing branch clones on **EFS
(NFSv4)**. Three facts follow, and every design decision below traces back to them:

1. **Every warm Lambda container is a separate NFS client.** "Cross-process" concurrency
   includes Lambda-vs-Lambda, not just Lambda-vs-worker. In-memory coordination
   (mutexes, registries, WeakRefs) never crosses that boundary.
2. **NFS clients cache aggressively.** Attribute and dentry (name→inode) caches serve
   reads for ~3–60s on default EFS mounts (`noac` cannot be assumed). Close-to-open
   consistency revalidates a _file's_ attributes on open, but directory listings and
   name bindings can be served stale. Consequence: after you `rename()` a file into
   place, a **foreign** rename that landed at the server moments later can stay
   invisible to _your_ client for the whole cache window — reading back "your own"
   write proves nothing about who actually won.
3. **There is no cross-host notification.** inotify/chokidar do not propagate over NFS.
   The shared filesystem itself is the only coordination medium.

What the filesystem _does_ guarantee, and what we build on: `rename()` and `link()`
are atomic at the server; `link()`/`mkdir` fail with EEXIST **enforced by the server**,
immune to client caching.

## The four layers

Each layer has a precise, limited guarantee. Correctness comes from composing them;
bugs come from assuming one layer covers another's job.

### 1. In-process mutex — `utils/async-mutex.ts` (`withLock`)

A module-level, per-key FIFO mutex. Serializes concurrent operations **within one
process only**. Keys are strings; conventions in use: absolute file paths
(branch-metadata, comment-store, schema-store) and namespaced content-ID keys
(`${root}:id:${id}`, `${root}:create:${collection}/${slug}` in content-store — IDs are
rename-invariant, so the key survives concurrent renames; see content-store.ts).
Multi-key acquisition must be sorted (see `withLocks` in content-store.ts).

_Guarantee:_ deterministic serialization same-process. _Non-guarantee:_ anything
cross-process.

### 2. Per-file OCC — `utils/occ-json-write.ts` (`writeOccJsonFile`, `withOccRetry`)

Optimistic concurrency for mutable JSON files: a `version` counter and per-write
`writeId` in the payload; temp-file write in the same directory → version precheck →
atomic rename → short settle → writeId read-back. New files are created with
temp+`link()` (crash-atomic exclusive create; never `writeFile({flag:'wx'})`, which can
leave a partial file that breaks every later parse).

_Guarantee:_ detects lost writes between writers sharing the **same NFS client**
(same host). _Non-guarantee — read the doc comment in occ-json-write.ts:_ cross-host,
both the precheck and the read-back go through the local dentry/attribute cache, so
two writers on different hosts can each pass verification and silently clobber each
other for the full cache window. The settle is cheap same-host jitter absorption, not
a cross-host fix. OCC alone is therefore only acceptable for files where a rare
cross-host lost update is tolerable — and today no store settles for OCC alone.

### 3. Server-enforced lock — `utils/occ-json-write.ts` (`withOccFileLock`) and `utils/provisioning-lock.ts`

`proper-lockfile` mkdir-based locks: acquisition is atomic **at the NFS server**,
immune to client caching, auto-refreshed while the holder lives (`stale` recovers from
crashed holders). `withOccFileLock` is tuned for brief metadata writes;
`acquireProvisioningLock` for long build-time provisioning;
`utils/content-write-lock.ts` for content writes vs. the worker's rebase (below).

_Guarantee:_ genuine cross-process, cross-host mutual exclusion. _Cost:_ extra fs
round-trips per acquisition — reserve it for writes where a lost update is
unacceptable (branch status/ACLs, user comments, content files against a rebase), not
for every file touch, and never on a read path.

_Caveat, stated plainly:_ staleness is judged by reading the lock directory's mtime
with `fs.stat`, which on EFS is served through the **NFS attribute cache**. A live
holder refreshes every `stale`/2, but a waiter can read a cached mtime, conclude the
lock is stale, and take it over while the holder is very much alive. So this layer is
_mutual exclusion in the normal case_, not a proof. Where it matters, note that the
failure mode of a bad takeover is whatever the code did before the lock existed — that
is what makes adding it a strict improvement rather than a guarantee to build further
assumptions on.

**Anchor path matters.** proper-lockfile keys its module-level `locks{}` bookkeeping
(refresh timer, release fn) by the **target path** passed to `lock()`, not by
`lockfilePath`. Two locks in one process that pass the same target alias each other
even with different lock names. Every lock here therefore anchors on something unique to
that lock: `withOccFileLock` locks the FILE rather than its directory, and both
`provisioning-lock.ts` helpers anchor on the lock MARKER's own path. That makes the
registry key identical to the on-disk lock identity, so two live locks can no longer share
a key at all — aliasing is structurally impossible rather than avoided by convention.

Markers still LIVE in a per-purpose directory — `{branchRoot}/.canopy-meta` for the
content-write lock, `{workspaceRoot}/.settings-init` for settings init (rather than
`path.dirname(settingsRoot)`, which is `{workspaceRoot}`, the very directory
`ensureLocalSimulatedRemote` puts `.remote-init.lock` in, and which settings init calls
into while holding its own lock). That placement is now about keeping markers out of each
other's way on disk and out of the git working tree, not about dodging the registry.

_This bit us._ Until 2026-08-20 both provisioning-lock variants passed the shared
content-branches directory as the target, so every branch under one root aliased a single
registry entry. Acquiring `.branch-b.init.lock` overwrote `.branch-a.init.lock`'s entry,
so releasing A tore down B's refresh timer, made B's own release fail with `ERELEASED`,
and leaked B's lock directory on disk until `stale` expired. The orphaned refresh timer
then `stat`ed a path its owner had already deleted and raised `ECOMPROMISED` — which,
under proper-lockfile's default `onCompromised` (rethrow from a timer), is an **uncaught
exception that kills the process**. In the test suite that surfaced as an intermittent
"Unhandled Error" failing the run while every test passed. Both variants now anchor on the
lock marker's own path (`realpath: false`, since the marker need not exist yet) and pass an
`onCompromised` that logs instead of crashing. Regression coverage:
`utils/provisioning-lock.test.ts`.

**Never let a compromised lock kill the process.** proper-lockfile's default
`onCompromised` rethrows from inside its refresh timer, i.e. an uncaught exception. By the
time a compromise is reported the mutual exclusion is already gone, so crashing protects
nothing — it just converts a lock failure into an outage for a Lambda serving unrelated
requests, or an unhandled error for a test worker. `provisioning-lock.ts` therefore wraps
whatever handler a call site supplies in a `try/catch`, so this holds even if the handler
(or the logger it calls) throws — which is not hypothetical: under `CI=true` vitest's
`onConsoleLog` turns any console write into a throw.

**Then decide, per call site, what a compromise means for that critical section.** It is a
parameter, not a fixed policy, because the right answer differs: provisioning logs and
finishes (idempotent, and a real concurrent provisioner fails loudly on its own), whereas
the content-write lock must not let the work stand unexamined — `withContentWriteLock`
raises a retriable `ContentWriteLockBusyError` telling the editor to reload before saving
again, and the worker's rebase stops before the next destructive git step. The one thing
that is NOT a valid response is skipping cleanup for work that already happened: a rebase
that completed owns the [SYNC-H1] history-rewrite marker and its cache invalidation, and a
caught-up branch is never revisited (`behindCount === 0`), so bailing there wedges the
branch permanently.

### 4. Generation markers for regenerating caches — `resource-generation.ts`

For caches rebuilt by scanning (not merged by read-modify-write), locking is the wrong
tool; freshness signaling is. Each resource has a marker file
`{root}/.canopy-meta/{resource}.generation` holding a random token.

The protocol (full rationale in resource-generation.ts's doc comment):

- **Mutators bump AFTER mutating** (random token, not a counter — no read-modify-write
  to lose).
- **Regenerators capture the token BEFORE scanning and embed it in the snapshot.**
- **Readers compare the snapshot's embedded token to the live marker**; mismatch ⇒
  regenerate. A regeneration that raced an invalidation lands a snapshot embedding the
  _old_ token — self-describing as stale, healed on the next read. No lock needed;
  concurrent regenerations are last-write-wins and each self-describing.
- Regeneration returns its own scan result — never loop until tokens match (livelock
  under bump storms).
- `mustSucceed` bumps for explicit invalidation paths (a swallowed failure there means
  indefinite staleness with no backstop); log-and-swallow "hint" bumps for bulk
  `finally`-block callers.
- Marker read _errors_ (≠ ENOENT) are distinguished from "never bumped": consumers
  serve the fresh scan but skip persisting a snapshot whose token they can't attribute.

**Durable-snapshot caveat (window E, below):** for consumers that persist their
snapshot to disk (registry, schema cache), a scan served from stale NFS caches can
durably record a fresh token over stale data — a _shared_ staleness all hosts trust
until the next bump. Mitigations: **eager regeneration on the mutating host** right
after its bump (its own scan is coherent with its own mutation) — the registry does
this inside `invalidate()`, the schema cache one level up in
`SchemaOps.invalidateSchemaCache()` — and, for the registry, a **suspicious-miss
backstop** (`get()` on a name missing from the snapshot forces one throttled rescan).
The schema cache has no equivalent miss signal; bulk-mutation bumps (git ops) accept
the lazy next-read regen there.

One more accepted transient: during a **rolling deploy**, an old-version process
neither reads markers nor writes token-embedded snapshots (and writes the retired
`.stale` files new readers ignore), so old and new processes can be mutually stale
for the deploy window. Strict snapshot `version` checks make the new code regenerate
over anything the old code wrote; the window closes when the old processes drain.

## Who uses what

| Resource (file under the workspace)                                               | Mutex (1)           | OCC (2)    | Lockfile (3)                                                                           | Marker (4)                                    | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------- | ------------------- | ---------- | -------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Content entries (`content/**`)                                                    | ✔ content-ID keys   | —          | ✔ `.canopy-meta/content-write.lock`                                                    | `content-index` bump on own writes            | Wrong-file writes prevented by the existence guard in `ContentStore.write()`; slug creates take a per-slug create key. The lockfile is [SYNC-C1] cross-host exclusion against the worker's rebase loop, taken by `write`/`delete`/`renameEntry` (never by reads) — see "Content writes vs. the rebase loop" below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ContentId index (in-memory per store)                                             | rebuild dedup       | —          | —                                                                                      | ✔ reader protocol in `ContentStore.idIndex()` | Suspicious-lookup backstop; window E stays in-memory (never persisted)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Reference resolve cache (in-memory per listing CALL)                              | in-flight dedup     | —          | —                                                                                      | — (deliberately none — see Notes)             | `ReferenceResolveCache` in content-store.ts, created per opted-in `listEntries`/`buildContentTree` call by `createReferenceResolver` and dropped when it returns. **Needs no marker protocol and must not grow one**: it is strictly shorter-lived than the per-call `ContentStore` whose `idIndex()` it sits on, so it adds no staleness window that store does not already have, and it never crosses a request or a host. It stores the in-flight **promise** per content ID, so concurrent `Promise.all` lookups collapse onto one read. Misses are memoized alongside hits so one batch answers a given id consistently; the accepted cost is that a repeat occurrence can no longer get incidentally lucky after a sibling wins the `refreshIndexForSuspiciousLookup` throttle — each DISTINCT id still runs the full self-healing retry, because that retry lives inside the memoized promise |
| Branch registry (`branches.json` at baseRoot)                                     | regen dedup         | —          | —                                                                                      | ✔ `branch-registry`                           | Durable snapshot: eager regen in `invalidate()`, `get()` miss backstop                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Schema cache (`.canopy-meta/schema-cache.json`)                                   | — (disk-only cache) | —          | —                                                                                      | ✔ `schema`                                    | Durable snapshot: mutating request re-reads immediately (same-host coherent); dev-only mtime walk for hand edits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Branch metadata (`.canopy-meta/branch.json`)                                      | ✔ path key          | ✔          | ✔                                                                                      | — (registry bumped after save)                | Status + ACLs: security-adjacent, hence the lockfile                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Comments (`.canopy-meta/comments.json`)                                           | ✔ path key          | ✔          | ✔                                                                                      | —                                             | User data: lost updates unacceptable, hence the lockfile                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Branch refs in the bare `remote.git`                                              | —                   | ✔ in git   | —                                                                                      | —                                             | No lock: git's own compare-and-swap is the concurrency control against the Lambda pushing into the same bare repo. Reads are stale the instant they return, so every write states the value it expects — `update-ref <new> <old>` in `reconcileTrackedBranches` (all-zeros OID to assert "must not exist"), and `--force-with-lease=<branch>:<sha>` when the rebase loop publishes a rewritten history. A lost race is never a lost update: the write is refused and the branch is revisited next cycle. The lease's expected value must be the commit the rebase replaced, NEVER remote.git's current tip — see ARCHITECTURE.md "Publishing a Rewritten History" (worker/cms-worker.ts)                                                                                                                                                                                                             |
| Settings files (`{settingsRoot}/permissions.json`, `groups.json`)                 | ✔ path key          | ✔ advisory | ✔                                                                                      | —                                             | Authorization data, but git-committed on the settings branch: a merge can rewrite `version`, so OCC is defense only — the lockfile is the guarantee; commit+push stays outside the lock (authorization/settings-file-store.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Collection meta (`content/**/.collection.json`)                                   | ✔ surrogate key     | —          | ✔ `.canopy-meta/schema`                                                                | `schema` bump after mutation                  | Adopter-visible git-committed file: deliberately NO OCC fields (rebases rewrite them; crash-leftover OCC temp files would enter `git add .` at publish). One coarse per-branch surrogate lock spans each full read-modify-write, incl. multi-file mutations; CLI migrate takes the same lock, but only inside branch clones (schema/schema-store.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Workspace provisioning                                                            | —                   | —          | ✔ provisioning-lock                                                                    | —                                             | Parallel build workers provisioning the same clone                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Settings workspace init (`{settingsRoot}`, clone + orphan checkout)               | ✔ single module key | —          | ✔ provisioning-lock at `{workspaceRoot}/.settings-init`                                | — (`skipIndexMarker`)                         | Two Lambda containers cold-starting together would otherwise both clone into one directory, and a loser arriving mid-clone could `rm -rf` a half-written `.git`. The loser now WAITS and finds the workspace done. Orthogonal to the lock: the lock-free rename guard that refuses `checkout --orphan` + `rm -rf .` on a populated workspace whose settings-branch name changed — see the History section (settings-workspace.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Branch purge (admin `POST /admin/branch-dirs/:dirName/purge`)                     | —                   | —          | ✔ provisioning-lock (zero-retry `tryAcquireProvisioningLock`) + ✔ branch.json lockfile | `branch-registry` invalidated after rename    | Double hold, both taken before the rename: the provisioning lock rejects (409, no retry) a genuinely in-flight provisioner; the branch.json lockfile — the SAME lock every metadata `save()` takes — closes the window where a concurrent repair-metadata `save()` resurrects branch.json mid-purge. Rename-only (`.trash-{dirName}-{STAMP}`), never deletes — see the trash-dir row below (api/admin-branch-health.ts, branch-health.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Branch repair-metadata (admin `POST /admin/branch-dirs/:dirName/repair-metadata`) | —                   | —          | ✔ branch.json lockfile (archive-rename only)                                           | registry bumped by the subsequent `save()`    | `withOccFileLock` is NOT reentrant and `save()` takes it internally, so the lock is acquired only to rename the corrupt `branch.json` → `branch.json.corrupt-{STAMP}`, then released (exiting the callback) BEFORE `save()` runs and recreates defaults through its normal lock+OCC stack — calling `save()` while still holding would deadlock (api/admin-branch-health.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Trashed branch dirs (`.trash-{dirName}-{STAMP}`)                                  | —                   | —          | —                                                                                      | —                                             | Reversible holding area for purge, not itself lock/OCC/marker-protected. Retention age comes ONLY from the STAMP embedded in the directory name, never mtime (`fs.rename` preserves the source dir's original mtime, so an mtime-based check would delete a months-stale orphan's trash on the first pass). Only the worker's `cleanupTrashedBranchDirs()` deletes, once per `syncGit()` cycle, sweeping stamps older than 30 days; purge itself never deletes (worker/cms-worker.ts)                                                                                                                                                                                                                                                                                                                                                                                                                |
| Worker task queue                                                                 | —                   | —          | proper-lockfile lease                                                                  | —                                             | Single consumer; cross-directory rename claims                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Worker status (`.tasks/worker-status.json`)                                       | —                   | —          | —                                                                                      | —                                             | Not itself lock/OCC/marker-protected: full-snapshot atomic rename (temp+rename) makes read-modify-write moot, so plain last-write-wins is correct. Writer is whichever host holds the worker task-queue lease (row above); reader is Lambda `GET /admin/status`, stale-tolerant. Up to ~`taskTimeoutMs` writer overlap possible right after a lock compromise (old holder still draining) — harmless, since every write is a complete snapshot, never a merge (worker/worker-status.ts)                                                                                                                                                                                                                                                                                                                                                                                                              |

Bulk working-tree mutations (git checkout/merge/rebase — including the worker's
ff-only base-branch refresh in `refreshBaseBranchWorkspace()` — sync, CLI sync, migrate) go
through `invalidateBranchContentCaches()` in content-index-generation.ts, which bumps
the `content-index` **and** `schema` markers — a rebase can pull in upstream
`.collection.json` changes, so both caches must be told. `invalidateContentIndexesDurable()`
(content-index marker only) is the documented entry point for a FUTURE content-only bulk
mutation site — it currently has zero production callers: `ContentStore`'s own
write/delete/rename bump the marker directly via `recordOwnMutation()` ->
`bumpContentIndexGeneration()`, not through this wrapper. Settings workspaces skip
markers entirely (`skipIndexMarker` on GitManager); their two mutable files follow the
mutable-JSON recipe instead (see the table row and
`authorization/settings-file-store.ts`).

## Content writes vs. the rebase loop [SYNC-C1]

The worker's `rebaseActiveBranches()` (worker/cms-worker.ts) and Lambda's `ContentStore`
mutate the **same branch working tree** on shared EFS. Content files had only the
in-process mutex, which does not cross that boundary, and the loop's "skip dirty
branches" check is plain check-then-act. Its old comment claimed the residual window was
safe because a racing save would make `git rebase` fail — true only for a save landing
**before** the rebase starts. After that (a window spanning fetch, replay and N conflict
rounds of git subprocesses on EFS) the save is destroyed two ways:

- `git checkout --theirs <file>` overwrites the just-saved working-tree content with the
  branch's committed version and stages it — **the rebase then succeeds and nothing logs
  a failure at all**; and
- `git rebase --abort` hard-resets the tree, discarding it.

Either way the editor already received a 200. That is an acknowledged write rolled back
with no error on either side — which is why "no writes to the wrong file" was never a
sufficient statement of write-path safety.

The fix is one server-enforced lock per branch root
(`utils/content-write-lock.ts`, layer 3), used **asymmetrically**, because the worker
retries every branch automatically each sync cycle (~5 min) while the editor is a person
waiting on a save:

- **The worker yields.** It acquires with zero retries
  (`tryAcquireContentWriteLock`) _before_ the dirty check — so that check is itself
  inside the lock — and holds it across the whole rebase, every conflict round, and any
  `--abort`, releasing in a `finally` so a throw cannot strand it. On contention it logs,
  records the branch in the cycle summary's `skippedLocked` (surfaced in
  `worker-status.json` and the admin panel, alongside `skippedDirty`), and retries next
  cycle. The refresh heartbeat is a timer on the worker's event loop and every git step
  is an awaited subprocess, so it keeps firing for the length of the hold.
- **Writers wait, briefly, then fail loudly.** `write`/`delete`/`renameEntry` wrap their
  existing `withLock` critical section in the lock with a short bounded wait
  (`DEFAULT_CONTENT_WRITE_LOCK_WAIT_MS`, 2s; retrying only on `ELOCKED`). A rebase holds
  the lock far longer than any wait an interactive save can absorb, so the wait exists to
  absorb handoff and short holds — everything longer becomes `BranchSyncingError` (a
  `ContentConflictError` subclass, so every existing 409 mapping keeps working) whose
  message says the branch is busy (syncing, or another save in flight) and to retry,
  rather than blaming another editor. The message names both causes because the lock has
  both: it is per-branch-root, so this is the **writer-vs-writer** budget as well as the
  rebase one, and every write to a branch now serializes behind it where in-process
  serialization used to be per-entry.
- **Reads never take it.** An EFS round-trip on every read is not an acceptable price,
  and a read racing a rebase gets an older or newer file, never a destroyed one.

Acquisition order is always content lock → `withLock`, never the reverse. The lock
keeps its marker under `{branchRoot}/.canopy-meta` (git-excluded, so the marker can never
dirty the tree or land in a publish commit) and anchors on that marker path, like every
other lock here — so per the aliasing note in layer 3 it cannot share a registry key with
the branch's provisioning lock.

**Residual (accepted):** the stale-takeover caveat in layer 3 applies here too — a
waiter reading a cached mtime can take the lock from a live rebase. The result is
exactly the pre-lock behavior for that one window, so this is a strict improvement and
not a guarantee that an acknowledged write can never be rolled back. Not covered by this
lock: schema mutations (`SchemaOps`, incl. `deleteCollection`) and asset writes, which
touch the working tree through their own paths.

## Residual staleness windows (accepted, bounded)

Named A/B/C/E for continuity with the original analysis
(`.claude/future-tasks/resolved/index-staleness-multiprocess.md`):

- **(A) Attribute caching, benign direction:** another host may not see a new marker
  for up to the cache window (~3–60s); it keeps serving its stale cache until then.
- **(B) Probe throttles:** freshness checks are debounced (e.g. 1s in
  `ContentStore.idIndex()`); staleness up to the throttle.
- **(C) Self-adoption:** a store that adopts the token of its own bump can miss one
  concurrent foreign bump.
- **(E) Fresh-token/stale-scan, malignant direction:** a regeneration whose reads are
  served from stale NFS caches records a NEW token against PRE-mutation data.
  Structurally unfixable with a filesystem marker. Scope differs by consumer: for the
  in-memory ContentId index it poisons one process until its (per-request) lifetime
  ends or the backstop fires; for durable snapshots it would be shared by all hosts
  until the next bump — which is why the eager-regen and suspicious-miss mitigations
  above exist.
- OCC cross-host blind spot (layer 2's non-guarantee) — closed by layer 3 where it
  matters.

All are bounded by per-request store lifetimes, throttled backstops, and the next
mutation's bump. None of them cause a write to land in the wrong _file_ — that is
prevented independently (existence guard, ID locks, server-enforced locks, and the
duplicate-ID guard below). Read that narrowly: "the right file" is not the same as
"the write survives". Until [SYNC-C1] above, a correctly-targeted, already-acknowledged
write could still be rolled back wholesale by the worker's rebase; the lock closes that,
subject to the stale-takeover caveat noted there.

## Duplicate content IDs vs. the write path [F1]

A duplicate embedded content ID (rename-crash debris, or a merge landing two files that
share one ID) is **quarantined, not fatal**: `ContentIdIndex.buildFromFilenames()` keeps
one deterministic winner (string-MIN of the relative paths, so every host agrees) and
drops the loser from the index, recording it for `branch-health` and the
`repair-content-duplicates` admin action.

Quarantine is an **index** decision and nothing more. It is tempting — and was, briefly,
written down as fact — to describe the dropped file as inert until an admin repairs it.
It is not: slugs resolve by directory scan (`ContentStore.buildPaths()`), which knows
nothing about the quarantine, so the dropped file stays fully addressable by
collection+slug and a stale editor tab can still save to it.

That is a hazard specifically for `write()`, because its post-write index repair reads
"the index puts this ID somewhere else" as "the slug changed" and `unlink`s that other
path. With a duplicate, that other path is a **different document** — so the save
silently deleted the kept file and returned 200. Now `write()` refuses first, with
`DuplicateContentIdError` (a `ContentConflictError` subclass → 409 carrying its own
message, naming both files and the repair action). Two independent detections, because
neither alone is sufficient: the index's own quarantine record (catches a duplicate in
another directory, and ID-addressed writes to a fresh third path, but needs a fresh
index), and a disk check that the write's target **and** the indexed path both exist
right now (freshness-independent, covers the ordinary slug-addressed save). A third,
in-directory scan in the `existingId` existence guard refuses when two files there carry
the ID, so that guard can no longer pass or 409 depending on `readdir()` order.

`delete()` and `renameEntry()` are deliberately **not** blocked: each only ever touches
the file the caller addressed (they look the entry up by path, and the dropped path is
not in the index at all), so neither can lose the kept file — and leaving them open
means a duplicate can still be cleaned up by hand without an admin.

**The rule this generalizes to:** an index is a hint about where an ID lives, never
authority to delete. Before removing a path you derived from the index rather than from
the caller's own request, prove the ID identifies exactly one file.

## Recipes

**Adding a regenerating cache** (rebuild-by-scan): follow the marker protocol —
choose a resource key; bump (`mustSucceed`) in your `invalidate()`; capture-before-scan
and embed the token in the snapshot; strict snapshot `version === N` check; compare
embedded vs live token on read; skip persisting on marker read errors; dedup in-process
regenerations; if the snapshot is durable, add eager regen on the mutating host and a
suspicious-miss backstop. Reference implementations: `branch-registry.ts` (durable,
with backstops) and `branch-schema-cache.ts`.

**Adding a call-scoped memo** (a `Map` you create at the top of one operation and drop when
it returns — e.g. `ReferenceResolveCache`): none of the above applies, and adding a marker
protocol to one would be cargo-culting. The test is lifetime, not shape: a memo that cannot
outlive the object whose freshness it depends on inherits that object's staleness properties
and introduces none of its own. Keep it that way — never hoist one to module scope, never
persist it, never reuse one across requests, and key it on something a rename cannot
invalidate (a content ID, not a path). Memoize the in-flight **promise**, not the settled
value, so concurrent callers collapse rather than racing. Decide deliberately whether misses
are cached: caching them buys within-batch consistency at the cost of any per-occurrence
retry the uncached path would have given you, so say which you chose and why.

**Adding a mutable JSON file** (read-modify-write): wrap mutators in
`withLock(resolvedPath)`; write via `writeOccJsonFile` with `withOccRetry`; translate
`OccWriteConflictError` to your public error type **at the boundary, after retries**
(translating inside the write path silently disables the retry predicate — this bug
has been caught in review once already). Add `withOccFileLock` when a cross-host lost
update is unacceptable. Always `path.resolve` the root that feeds your lock key.
Reference implementations: `comment-store.ts`, `branch-metadata.ts`,
`authorization/settings-file-store.ts`.

**Git-committed files are a special case.** OCC `version` counters only mean something
in files git never rewrites (`.canopy-meta/*`). In a file that merges/rebases rewrite
wholesale, the counter can move backwards or vanish, so it cannot be a correctness
mechanism: the settings files keep OCC as defense-in-depth with the lockfile as the
actual guarantee (see `settings-file-store.ts`'s doc comment), and `.collection.json`
skips OCC fields entirely — an adopter-visible schema file gets no version/writeId
churn — relying on layers 1+3 via a coarse per-branch surrogate lock at
`.canopy-meta/schema` held across each full read-modify-write
(`schema/schema-store.ts`'s `withSchemaLock`).

**Bulk tree mutation** (anything git-like that rewrites many files): call
`invalidateBranchContentCaches(branchRoot)` after the mutation completes — and if it
rewrites the working tree of a branch editors can write to (checkout/merge/rebase/reset),
take the content-write lock around it too (`withContentWriteLock`, or
`tryAcquireContentWriteLock` if your caller can retry later). Cache invalidation tells
readers the tree changed; only the lock stops a concurrent save from being reverted by
it.

**Never do:** counters in marker files (lost-update prone); `writeFile({flag:'wx'})`
for exclusive creates (not crash-atomic); trusting a post-rename read-back across
hosts; locking on physical paths that a rename can invalidate; a fixed sleep as a
cross-host correctness mechanism; deleting a file the caller did not address because
an in-memory index says its ID moved (see [F1] above).

## Testing patterns

All in use today; copy them rather than inventing new ones:

- **Deterministic interleavings** over sleeps: a `protected` scan/resolve hook
  overridden by a test subclass with a manually-resolved deferred
  (`branch-registry.test.ts` "self-heals the GIT-M1 race",
  `branch-schema-cache.test.ts`), or gating a specific fs call
  (`content-store.test.ts` rename-race tests).
- **Foreign-host simulation:** overwrite the marker file directly — that _is_ what
  another host's bump looks like locally.
- **Process-boundary smoke test:** spawn plain `node -e` (not tsx — sandbox-hostile)
  to mutate files + bump the marker from a real second process
  (`branch-schema-cache.integration.test.ts`).
- **Settle/backoff injection:** stores accept `{ settleMs: 0 }` in tests; keep suites
  fast, never assert on wall-clock sleeps.
- **Regression honesty:** when fixing a race, check the new test reproduces the
  corruption against the pre-fix code (stash the fix, run, restore).

## History

August 2026 (baseline review, [SYNC-C1]): content files gained cross-process write
exclusion against the worker's rebase loop (`utils/content-write-lock.ts`) — see
"Content writes vs. the rebase loop" above. Before it, content entries were the one
mutable resource class relying on the in-process mutex alone.

Designed across PR #94 (ContentId index marker) and the July 2026 EFS cross-process
concurrency epic (PRs #111–#116: shared primitives, branch-registry GIT-M1,
branch-schema-cache GIT-M2, comment-store GIT-M3, branch-metadata GIT-M4, content-store
lock keys). Background analysis: `.claude/future-tasks/resolved/index-staleness-multiprocess.md`
and `.claude/future-tasks/resolved/efs-cross-process-concurrency.md`.

Extended July 2026 (post-epic follow-ups): the settings files adopted the full
mutable-JSON stack (`authorization/settings-file-store.ts`, unifying the old
app-level `contentVersion` scheme into the OCC `version`), and `.collection.json`
mutations were serialized behind the coarse `.canopy-meta/schema` surrogate lock —
see `.claude/future-tasks/resolved/settings-file-occ-cross-host.md` and
`.claude/future-tasks/resolved/schema-store-rmw-protection.md`.

Also in July 2026: `deploymentName` (which namespaces the settings orphan branch,
`canopycms-settings-{deploymentName}`) became resolvable from an environment variable
in addition to config, via `operating-mode/deployment-name.ts`'s `resolveDeploymentName`.
This introduced a new boot-time invariant worth naming here even though it added no new
locking primitive: `SettingsWorkspaceManager.ensureGitWorkspace` (settings-workspace.ts)
now checks, via `GitManager.repoExistsAt()`, whether a settings workspace already
exists on disk and — if so — whether its checked-out branch matches the newly-resolved
name; a mismatch throws instead of letting `GitManager.initializeWorkspace` proceed to
`checkout --orphan` + `rm -rf .` on a populated workspace (orphan branches share no
history, so that sequence is not recoverable).

**The rename refusal comes from the guard, not from a lock — and that is deliberate.**
The guard runs **lock-free, before** any lock is acquired, and again **under** the lock
before init. It is never gated on winning a race: a deployment whose resolved
settings-branch name no longer matches the workspace on disk is misconfigured, not
contended, so it must refuse immediately rather than queue behind a live provisioner
(which can legitimately hold the lock for minutes on a slow EFS clone). The re-run under
the lock exists because the lock-free sample can go stale while waiting — the previous
holder may have created the workspace, or moved it onto _its_ settings branch, after we
looked — and acting on that stale sample is exactly the destructive path.

> ⚠️ Do not "simplify" this by running the identity check only once, under the lock, or
> by gating it on any "did I acquire it" flag. Both readings have been proposed before;
> see
> [`.claude/future-tasks/settings-workspace-init-lock-uncatalogued.md`](../.claude/future-tasks/resolved/settings-workspace-init-lock-uncatalogued.md)
> for the history of that trap.

**August 2026 (baseline review, B2): the settings-workspace init lock became a real
lock.** It used to be a bespoke pair — an in-memory promise plus a file-based
`O_CREAT|O_EXCL` marker with a fixed 30s mtime staleness window — and the file-based half
synchronized nothing: its return value was read _only_ to decide whether to release in
the `finally`, so a process that lost the race proceeded into
`GitManager.initializeWorkspace` anyway, concurrently with the holder. Since
`initializeWorkspace` is only _sequentially_ idempotent, two concurrent cold starts on an
empty settings root both cloned into the same directory ("could not create work tree dir
… File exists"), and a loser that arrived mid-clone could classify the half-written
`.git` as corrupt and `rm -rf` it out from under the in-flight clone. The bespoke lock had
two further defects: two waiters could both judge it stale and both `unlink` it (no
inode/content identity check, so the second deletes a _fresh_ lock), and it was never
refreshed, so an init slower than 30s — an ordinary EFS clone — had its lock stolen.

It is now layer 3, `acquireProvisioningLock`, exactly as `branch-workspace.ts` uses for
content clones: server-enforced acquisition, heartbeat-refreshed while the holder lives
(so a slow clone is not mistaken for a crash), and patient jittered retries so the loser
**waits** and then finds the workspace already initialized. That waiting is the design
change — the old comment defended the loser proceeding; it no longer does.

Its anchor path is deliberately its own dot-directory,
`{workspaceRoot}/.settings-init` (`settingsInitLockTarget()`), for two reasons. It cannot
live inside the settings root, because `acquireProvisioningLock` mkdir's the directory its
marker goes in and `git clone` refuses a destination with content in it. Keeping it in a
dedicated dot-directory also keeps it clear of `.remote-init.lock`, which
`ensureLocalSimulatedRemote` creates in `path.dirname(settingsRoot)` (= `{workspaceRoot}`)
and which settings init calls into while holding this lock. Since 2026-08-20 that nesting
is no longer a registry hazard — locks anchor on their own marker paths, so the two can
never share a key — but keeping the markers in separate directories keeps the nesting
obvious rather than incidental.
