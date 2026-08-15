# Ten small verified defects from the August 2026 baseline review

## Priority: P3

Split out of [baseline-2026-08-production-and-followups.md](resolved/baseline-2026-08-production-and-followups.md)
(the still-open remainder of finding B7) on 2026-08-13, when that review's
significant findings were fixed and the record moved to `resolved/`.

Each item below was **individually re-verified at `78e4ca8b`** with current line
numbers. Two of B7's original items are excluded: sub-item 9 (meta-loader
dropping nested plain directories) is **already fixed** — `schema/meta-loader.ts:104,168`
now recurses into directories without a `.collection.json`, and was never struck
— and sub-item 11 (dev watcher `contentRoot`) was fixed in PR #211. Three others
(12, 13, 14) moved to
[authorization-enforcement-consolidation.md](authorization-enforcement-consolidation.md)
because they share that file's theme.

These are independent; pick them off opportunistically.

1. **`createCollection` has no duplicate-slug check** though rename does
   (`schema/schema-store.ts:600-667`, no existence check before `fs.mkdir`). So
   `posts.id1/` and `posts.id2/` coexist and first-match resolution is
   nondeterministic across hosts.
2. **Entry-delete order cleanup is an RMW whose read sits outside the lock**
   (`api/entries.ts:465-475`) — `collection.order` is read pre-lock, and
   `updateOrder` then takes its own lock. PR #225 fixed only the false-500 half.
3. **A corrupt `branches.json` bricks listing** instead of regenerating:
   `branch-registry.ts:118-125` regenerates on `isNotFoundError` only and
   rethrows a `SyntaxError`.
4. **A crash between `completeTask` and `updateBranchMetadata` wedges
   `syncStatus`** — fixed by flipping two lines at `worker/cms-worker.ts:768-769`.
5. **Crash-leftover `*.tmp` files are staged by submit's `git add '.'`**
   (`services.ts:337`); the only `.git/info/exclude` pattern is `.canopy-meta/`
   (`git-manager.ts:260`). Debris from `utils/atomic-write.ts`.
6. **`q=` is silently ignored when `f=` is omitted**, though the cache key
   carries it (`assets/transform.ts:242` —
   `format ? encode(pipeline, format, quality) : …`).
7. **An entry slugged `all` is overwritten by the collection aggregate**
   (`ai/generate.ts:284` writes `${cleanPath}/all.md`).
8. **`flattenSchema` drops the root collection label**
   (`config/flatten.ts:102`, `label: undefined`), so root label edits persist but
   never display.
9. **`sync push --force` on a conflicted workspace logs the error and exits 0**
   (`cli/sync.ts:385-388` throws only `if (!options.force)`).
10. **Switching back to an already-loaded entry sends raw unresolved reference
    IDs to the preview** — `editor/Editor.tsx:340-343` resets `previewData` and
    `:917` falls back to the raw `effectiveValue`.

## Related

- [authorization-enforcement-consolidation.md](authorization-enforcement-consolidation.md)
- [branch-namespace-validation-gaps.md](branch-namespace-validation-gaps.md)
- [acl-defaults-and-dead-path-checker.md](resolved/acl-defaults-and-dead-path-checker.md)
