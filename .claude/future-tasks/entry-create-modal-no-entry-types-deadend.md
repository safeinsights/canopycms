# "Add Entry" on a container-only collection opens a modal that can never submit

**Priority:** P2 — reachable UI dead-end with no explanation shown
**Found:** 2026-08-12, while fixing
[resolved/entry-create-modal-slug-reset-race.md](resolved/entry-create-modal-slug-reset-race.md)
(noticed in passing; deliberately left out of that PR's scope)

## Symptom (traced in code, not yet reproduced in the running app)

For a collection that has no entry types, the "Add Entry" menu item still
appears, the create modal still opens, and the **Create button is permanently
disabled with nothing explaining why**. The only escape is Cancel.

## Mechanism

- `config/schemas/collection.ts:51` declares `entries` optional, with a refine
  requiring `entries || collections`. A container-only collection (sub-collections,
  no entry types of its own) is therefore valid config — as is `entries: []`,
  since `[]` is truthy and satisfies the refine.
- `EntryNavigator.tsx:536` gates the "Add Entry" item on `onAdd` alone, not on the
  collection having any entry type.
- `useEntryManager.handleCreateEntry` only bails for `col.type === 'entry'`; a
  container collection is `type: 'collection'`, so the modal opens.
- In `EntryCreateModal`, `getDefaultEntryTypeName()` returns `''` for an empty
  `entryTypes`, and `canCreate` requires `entryTypeName !== ''` — so Create is
  disabled from the moment the modal opens. The "Please select an entry type"
  message only fires from `handleCreate`, which a disabled button can never reach.
  With `entryTypes.length === 0` neither the `> 1` Select nor the `=== 1` label
  renders, so there is not even a control to interact with.

That `handleCreateModalSubmit` falls back to `createModalCollection.format` when
no entry type matches suggests entry-type-less collections were anticipated
somewhere in this path.

## Fix direction

Decide which is intended, then make the UI agree:

- If entry-type-less collections should not accept entries: hide/disable "Add
  Entry" for them (gate the menu item on the collection having entry types),
  which also stops `handleCreateEntry` opening a useless modal; or
- If they should: give the modal a defined behaviour for the empty case — fall
  back to the collection's own `format` (as the submit path already half does)
  and let Create proceed.

Either way the modal should explain itself rather than presenting a dead button.

## Not verified

Whether any real schema in this repo (or docs-site-proto) actually produces a
container-only collection reachable from the navigator with `onAdd` wired. The
config schema permits it and no code on the path blocks it; the reachability
check is the first step of this task.
