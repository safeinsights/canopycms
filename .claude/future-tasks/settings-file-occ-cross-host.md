# Audit settings-file OCC for cross-host safety

**Priority: P2** — authorization data; same failure class the EFS epic fixed elsewhere

## Problem

The settings workspace files (`permissions.json`, `groups.json`) use their own
app-level `contentVersion` optimistic-locking scheme that was NOT covered by the EFS
cross-process concurrency epic (PRs #111–#118, see
[docs/concurrency.md](../../docs/concurrency.md)). Rename-based OCC verification is
same-host-only on EFS: two warm Lambda containers are separate NFS clients, so a
foreign write can hide in the local dentry/attribute cache for 3–60s and both writers
can conclude they won — a silent lost update. For branch.json and comments.json the
epic closed this with a server-enforced lockfile (`withOccFileLock` in
`utils/occ-json-write.ts`); permissions/groups are authorization data, so a lost
admin edit there is security-adjacent.

## Task

1. Trace the settings write path (settings-workspace module; the `contentVersion`
   scheme referenced in ARCHITECTURE.md's operating-modes/settings section).
2. Determine whether a concurrent admin edit from another Lambda container can be
   silently lost.
3. If so, apply the layered pattern from the epic: `withLock` (in-process) +
   `withOccFileLock` (cross-host) + OCC as defense — reference implementations
   comment-store.ts / branch-metadata.ts, and the "adding a mutable JSON file" recipe
   in docs/concurrency.md.
4. Update docs/concurrency.md's per-resource table with the outcome either way.

## Origin

Flagged during the EFS concurrency epic's doc sweep (2026-07-21): the
docs-architecture agent identified the settings `contentVersion` scheme as a
separate, pre-existing OCC implementation outside the epic's scope.
