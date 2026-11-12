# `merge/` — Field-level three-way merge

The pure engine that merges one entry's ancestor, base and branch versions field by field, and
names each conflict as the "Show changes" drawer names a change. It imports no node built-in, so
the editor can run it in the browser; `pnpm lint:bundle` checks that.

The **code comment at the point of the rule is authoritative**; this file is the map.

## Cross-file invariants

- **One equality.** `value-equality.ts`'s `sameValue` serves the drawer (`editor/entry-diff.ts`)
  and the merge, so a value the drawer calls unchanged is never a conflict.
- **One item key.** `list-alignment.ts` keys ancestor items with `item-keys.ts`'
  `itemKeysAsRead`, as every read keys them, so an editor's first-save keys match.
- **One conflict name.** `conflict-path.ts` rebuilds `entry-diff.ts`' `EntryChange.key` and
  `dataPath` rules; the "agree with the drawer" tests in `entry-merge.test.ts` pin the two
  together.
- **One body parser.** The mdx re-parse check uses `utils/markdown-parse.ts`, as the save
  path's `utils/markdown-body-splice.ts` does.

## The one heuristic

Aligning list items no key names (`list-alignment.ts`) is the engine's one heuristic.
It covers items no ancestor key names, or under a stale first-save key. It can misread an
item keeping none of its values, holding another's, or changed under a stale key; and, with no
git-level merge, one a side made read exactly like a deleted item whose key still hashes it
(KNOWN LIMIT tests). Backfilled keys remove hand-edited cases.
`entry-merge.ground-truth.test.ts` and `entry-merge.sequence.test.ts` pin that edits to
different items, and two editors' edits to one item, never merge wrongly.

`entry-merge.test.ts`' header maps the plan's conflict-case rows to tests; the golden
fixtures are in `entry-merge.golden.test.ts`.
