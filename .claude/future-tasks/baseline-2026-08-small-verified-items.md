---
priority: P3
adopters: BOTH
summary: >-
  Seven independent small defects from the August baseline review (duplicate-slug check in `createCollection`, an RMW whose read sits outside the lock, a crash window wedging `syncStatus`, crash-leftover `*.tmp` staged by submit, an entry slugged `all`, `flattenSchema` dropping the root label, `sync push --force` exiting 0); the corrupt-`branches.json` item is its own task, `branch-registry-corrupt-snapshot`
---
# Small verified defects from the August 2026 baseline review

## Priority: P3

The still-open remainder of finding B7 of
[baseline-2026-08-production-and-followups.md](resolved/baseline-2026-08-production-and-followups.md).
The items are independent; pick them off opportunistically. Item 3 of the original list, a corrupt
`branches.json` bricking listing, is its own task:
[branch-registry-corrupt-snapshot.md](resolved/branch-registry-corrupt-snapshot.md). Three more moved to
[authorization-enforcement-consolidation.md](authorization-enforcement-consolidation.md).

1. **`createCollection` has no duplicate-slug check** though rename does
   (`schema/schema-store.ts:600-667`, no existence check before `fs.mkdir`). So `posts.id1/` and
   `posts.id2/` coexist and first-match resolution is nondeterministic across hosts.
2. **Entry-delete order cleanup is an RMW whose read sits outside the lock**
   (`api/entries.ts:465-475`): `collection.order` is read pre-lock, and `updateOrder` then takes
   its own lock.
3. **A crash between `completeTask` and `updateBranchMetadata` wedges `syncStatus`**: fixed by
   flipping two lines at `worker/cms-worker.ts:768-769`.
4. **Crash-leftover `*.tmp` files are staged by submit's `git add '.'`** (`services.ts:337`); the
   only `.git/info/exclude` pattern is `.canopy-meta/` (`git-manager.ts:260`). Debris from
   `utils/atomic-write.ts`.
5. **An entry slugged `all` is overwritten by the collection aggregate** (`ai/generate.ts:284`
   writes `${cleanPath}/all.md`).
6. **`flattenSchema` drops the root collection label** (`config/flatten.ts:102`,
   `label: undefined`), so root label edits persist but never display.
7. **`sync push --force` on a conflicted workspace logs the error and exits 0**
   (`cli/sync.ts:385-388` throws only `if (!options.force)`).

## Related

- [authorization-enforcement-consolidation.md](authorization-enforcement-consolidation.md)
- [branch-namespace-validation-gaps.md](branch-namespace-validation-gaps.md)
- [acl-defaults-and-dead-path-checker.md](resolved/acl-defaults-and-dead-path-checker.md)
