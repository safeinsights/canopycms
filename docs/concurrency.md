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
`acquireProvisioningLock` for long build-time provisioning.

_Guarantee:_ genuine cross-process, cross-host mutual exclusion. _Cost:_ extra fs
round-trips per acquisition — reserve it for writes where a lost update is
unacceptable (branch status/ACLs, user comments), not for every file touch.

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

| Resource (file under the workspace)                                               | Mutex (1)           | OCC (2)    | Lockfile (3)                                                                           | Marker (4)                                    | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------- | ------------------- | ---------- | -------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Content entries (`content/**`)                                                    | ✔ content-ID keys   | —          | —                                                                                      | `content-index` bump on own writes            | Wrong-file writes prevented by the existence guard in `ContentStore.write()`; slug creates take a per-slug create key                                                                                                                                                                                                                                                                                                                                                                   |
| ContentId index (in-memory per store)                                             | rebuild dedup       | —          | —                                                                                      | ✔ reader protocol in `ContentStore.idIndex()` | Suspicious-lookup backstop; window E stays in-memory (never persisted)                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Branch registry (`branches.json` at baseRoot)                                     | regen dedup         | —          | —                                                                                      | ✔ `branch-registry`                           | Durable snapshot: eager regen in `invalidate()`, `get()` miss backstop                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Schema cache (`.canopy-meta/schema-cache.json`)                                   | — (disk-only cache) | —          | —                                                                                      | ✔ `schema`                                    | Durable snapshot: mutating request re-reads immediately (same-host coherent); dev-only mtime walk for hand edits                                                                                                                                                                                                                                                                                                                                                                        |
| Branch metadata (`.canopy-meta/branch.json`)                                      | ✔ path key          | ✔          | ✔                                                                                      | — (registry bumped after save)                | Status + ACLs: security-adjacent, hence the lockfile                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Comments (`.canopy-meta/comments.json`)                                           | ✔ path key          | ✔          | ✔                                                                                      | —                                             | User data: lost updates unacceptable, hence the lockfile                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Settings files (`{settingsRoot}/permissions.json`, `groups.json`)                 | ✔ path key          | ✔ advisory | ✔                                                                                      | —                                             | Authorization data, but git-committed on the settings branch: a merge can rewrite `version`, so OCC is defense only — the lockfile is the guarantee; commit+push stays outside the lock (authorization/settings-file-store.ts)                                                                                                                                                                                                                                                          |
| Collection meta (`content/**/.collection.json`)                                   | ✔ surrogate key     | —          | ✔ `.canopy-meta/schema`                                                                | `schema` bump after mutation                  | Adopter-visible git-committed file: deliberately NO OCC fields (rebases rewrite them; crash-leftover OCC temp files would enter `git add .` at publish). One coarse per-branch surrogate lock spans each full read-modify-write, incl. multi-file mutations; CLI migrate takes the same lock, but only inside branch clones (schema/schema-store.ts)                                                                                                                                    |
| Workspace provisioning                                                            | —                   | —          | ✔ provisioning-lock                                                                    | —                                             | Parallel build workers provisioning the same clone                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Branch purge (admin `POST /admin/branch-dirs/:dirName/purge`)                     | —                   | —          | ✔ provisioning-lock (zero-retry `tryAcquireProvisioningLock`) + ✔ branch.json lockfile | `branch-registry` invalidated after rename    | Double hold, both taken before the rename: the provisioning lock rejects (409, no retry) a genuinely in-flight provisioner; the branch.json lockfile — the SAME lock every metadata `save()` takes — closes the window where a concurrent repair-metadata `save()` resurrects branch.json mid-purge. Rename-only (`.trash-{dirName}-{STAMP}`), never deletes — see the trash-dir row below (api/admin-branch-health.ts, branch-health.ts)                                               |
| Branch repair-metadata (admin `POST /admin/branch-dirs/:dirName/repair-metadata`) | —                   | —          | ✔ branch.json lockfile (archive-rename only)                                           | registry bumped by the subsequent `save()`    | `withOccFileLock` is NOT reentrant and `save()` takes it internally, so the lock is acquired only to rename the corrupt `branch.json` → `branch.json.corrupt-{STAMP}`, then released (exiting the callback) BEFORE `save()` runs and recreates defaults through its normal lock+OCC stack — calling `save()` while still holding would deadlock (api/admin-branch-health.ts)                                                                                                            |
| Trashed branch dirs (`.trash-{dirName}-{STAMP}`)                                  | —                   | —          | —                                                                                      | —                                             | Reversible holding area for purge, not itself lock/OCC/marker-protected. Retention age comes ONLY from the STAMP embedded in the directory name, never mtime (`fs.rename` preserves the source dir's original mtime, so an mtime-based check would delete a months-stale orphan's trash on the first pass). Only the worker's `cleanupTrashedBranchDirs()` deletes, once per `syncGit()` cycle, sweeping stamps older than 30 days; purge itself never deletes (worker/cms-worker.ts)   |
| Worker task queue                                                                 | —                   | —          | proper-lockfile lease                                                                  | —                                             | Single consumer; cross-directory rename claims                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Worker status (`.tasks/worker-status.json`)                                       | —                   | —          | —                                                                                      | —                                             | Not itself lock/OCC/marker-protected: full-snapshot atomic rename (temp+rename) makes read-modify-write moot, so plain last-write-wins is correct. Writer is whichever host holds the worker task-queue lease (row above); reader is Lambda `GET /admin/status`, stale-tolerant. Up to ~`taskTimeoutMs` writer overlap possible right after a lock compromise (old holder still draining) — harmless, since every write is a complete snapshot, never a merge (worker/worker-status.ts) |

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
mutation's bump. None cause _writes_ to the wrong file — write-path corruption is
prevented independently (existence guard, ID locks, server-enforced locks).

## Recipes

**Adding a regenerating cache** (rebuild-by-scan): follow the marker protocol —
choose a resource key; bump (`mustSucceed`) in your `invalidate()`; capture-before-scan
and embed the token in the snapshot; strict snapshot `version === N` check; compare
embedded vs live token on read; skip persisting on marker read errors; dedup in-process
regenerations; if the snapshot is durable, add eager regen on the mutating host and a
suspicious-miss backstop. Reference implementations: `branch-registry.ts` (durable,
with backstops) and `branch-schema-cache.ts`.

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
`invalidateBranchContentCaches(branchRoot)` after the mutation completes.

**Never do:** counters in marker files (lost-update prone); `writeFile({flag:'wx'})`
for exclusive creates (not crash-atomic); trusting a post-rename read-back across
hosts; locking on physical paths that a rename can invalidate; a fixed sleep as a
cross-host correctness mechanism.

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
history, so that sequence is not recoverable). This check runs entirely inside
`ensureGitWorkspace`'s own pre-existing in-memory + file-based (`O_CREAT|O_EXCL`) init
lock — a bespoke pair local to settings-workspace.ts, not one of the four numbered
layers above (it predates this change and is not yet cataloged in the table below) —
so two hosts racing to initialize the same settings workspace still can't both decide
it's safe and both destroy it.
