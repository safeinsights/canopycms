# Index Staleness and Multi-Process Consistency

## Status: RESOLVED (in-process PR #91, cross-process PR "fix/content-index-cross-process") — residual windows documented below

The `ContentIdIndex` maintains an in-memory mapping of content IDs to file paths per
`ContentStore` instance. It went stale when files changed underneath a store — by git
operations in the same process, or by ANY mutation in another process sharing the
filesystem (multiple warm Lambda containers + the EC2 worker on EFS; `canopy sync`
CLI beside `next dev` locally).

## What was implemented

### In-process (PR #91, commit 9dce11a)

- `content-index-registry.ts`: WeakRef registry keyed by resolved store root;
  `invalidateContentIndexesForRoot(root)` marks stores at/under a root stale.
- `ContentStore.idIndex()`: generation-counter lazy rebuild with in-flight dedup.
- Hooked into git checkout/pullBase/pullCurrentBranch/rebaseOntoBase (in `finally`),
  sync-core's content-dir swap, and the worker's rebase loop.
- Slug-change cleanup in `write()` (old Option 3) had already landed.

### Cross-process (this PR)

- **On-disk generation marker** (`content-index-generation.ts`): every mutation of
  indexed files rewrites `{branchRoot}/.canopy-meta/content-index.generation` with a
  fresh random token (atomic temp+rename). A random token instead of a counter: readers
  only need "changed since I captured it", and a counter's read-modify-write silently
  loses concurrent bumps without a lock.
- **Single durable entry point** `invalidateContentIndexesDurable(root)` = bump marker
  then in-process invalidation. Used by: GitManager working-tree ops, sync-core,
  the worker's rebase, SchemaOps collection create/rename/delete (previously not
  invalidating at all), and CLI `sync both`/`abort`/merge-abort paths (also previously
  uncovered — and the CLI is a separate process, so only the marker reaches the dev server).
- **Reader protocol** in `ContentStore.idIndex()`: throttled marker probe (default 1s,
  `indexFreshnessIntervalMs` option) when otherwise fresh; the token is captured
  *before* each scan and recorded only by the rebuild path, so a bump landing mid-scan
  forces another rebuild. Rebuilds now build a fresh `ContentIdIndex` and swap it in
  (never `clear()` in place), so in-flight holders keep a consistent snapshot.
- **Self-adoption**: a store's own `write()`/`delete()`/`renameEntry()` bumps the
  marker and adopts the written token (guarded: only when no rebuild raced), so own
  writes never trigger a self-rescan.
- **Suspicious-lookup backstop** (old Option 1, generalized): `readById` and reference
  resolution force one un-throttled rebuild on an ID miss *or* an index hit whose file
  is gone (ENOENT), then retry once. Time-boxed (5s window) so dangling IDs can't thrash.
- **Write existence guard**: `write()` with a caller-supplied `existingId` whose target
  file is missing consults the directory listing; if the ID actually lives at a
  different slug (another process renamed it), it throws `ContentConflictError` instead
  of recreating the old path — this closes the duplicate-ID-file corruption vector
  (two files with the same embedded ID poison every rebuild with "ID collision detected").
- Settings workspaces skip the marker (`skipIndexMarker` on GitManager): no ContentStore
  ever roots there, and orphan settings branches must not accumulate untracked files.
- CLI `sync` auto-created workspaces now get the `.canopy-meta/` git exclude
  (`ensureGitExcludePattern`), like fully provisioned workspaces always did.

### Rejected options (from the original proposal)

- **Filesystem watcher (chokidar)**: dead end — inotify does not propagate across
  hosts on NFS/EFS, and the prod deployment is exactly multiple hosts on EFS.
- **Startup `validateIndex()`**: subsumed — every per-request store already scans
  fresh on first access, and the backstop self-heals mid-request staleness.

## Residual staleness windows (accepted, documented in content-index-generation.ts)

All bounded in practice by per-request ContentStore lifetimes (every construction site
is request/call-scoped, so first access always scans fresh) and self-healed by the backstop:

- **(A) NFS attribute caching (benign direction)**: another host may not see a new
  marker for up to the attribute-cache timeout (~3–60s on default EFS mounts; `noac`
  not assumed). Stale token → stale index until the cache expires.
- **(B) Probe throttle**: up to `indexFreshnessIntervalMs` (default 1s).
- **(C) Self-adoption lost notification**: if a store's own bump lands after a
  concurrent foreign bump, the foreign mutation is missed until the backstop fires or
  the store dies; window = last token observation → own bump rename.
- **(E) Fresh-token/stale-scan (malignant direction, cross-host only)**: NFS
  revalidates the marker file on open, but a rebuild's `readdir`s may be served from
  dentry/attribute caches — a scan can record a NEW token against PRE-mutation
  listings, leaving that store confidently stale until the next bump. Structurally
  unfixable with a filesystem marker; bounded by per-request lifetimes + backstop.

## Small follow-ups (not blocking)

- A collision-poisoned tree (duplicate embedded IDs on disk, e.g. hand-edited) still
  makes every rebuild throw, 500ing the branch until fixed. The write existence guard
  prevents the CMS from *creating* that state, but a degrade-to-first-wins-with-warning
  rebuild could make it recoverable. Pre-existing behavior, unchanged.
- Worker rebase abort paths skip invalidation when the abort itself fails (tree state
  unknown); benign when abort succeeds. Pre-existing.
- Lock keys are still physical paths, not content IDs — see
  [content-store-lock-key.md](content-store-lock-key.md) (P2, unchanged by this work;
  the existence guard removes the worst consequence of that race).
