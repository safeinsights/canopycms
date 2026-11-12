---
'canopycms': patch
---

### `canopycms backfill-item-keys` writes every list item's key

<!-- migration
area: Branches
action: Optional
row: Run backfill-item-keys once on the base branch
-->

**What changed.** A new command writes the `_key` of every object-list item and block into your content, exactly as an editor save of the unedited entry would. Until a file holds its keys, an editor's first save adds `_key` lines beside the real edit, and those lines can conflict with changes the base branch makes to the same entry meanwhile. `--check` writes nothing and exits 1 when any file needs keys. See [Keying list items](../README.md#keying-list-items).

**To adopt.** Once, on a clean checkout of your base branch: run `npx canopycms backfill-item-keys`, review the files it lists as also normalised, and commit the result on its own, with nothing else in the commit. Optionally gate CI on `npx canopycms backfill-item-keys --check`.
