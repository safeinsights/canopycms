---
'canopycms': minor
---

### EntryNavigator's `revealCollection` prop is replaced by `reveal` — **breaking (EntryNavigator props)**

<!-- migration
area: Editing
action: Direct EntryNavigator users only
row: EntryNavigator revealCollection becomes reveal; new optional props
-->

**What changed.** `EntryNavigatorProps` loses `revealCollection` and gains `reveal`, a
`ContentPanelReveal` (a new export of `canopycms/client`). `EntryNavItem` gains an optional
`route`. The other additions are all optional: `onChangedOnlyChange`, `changedOnly`,
`unsavedCount`, `unsavedEntries`, `entryListFailed`, `branchNotAvailable`, `onSwitchBranch`,
`onFilterEnter`, `onFilterEscape`, `onRowMenuOpen`, `filterRef` and `filterShortcut`. No prop
became required, and the editor's own use of the navigator needs no change. Only code that
renders `EntryNavigator` directly is affected.

**To adopt.** Where you pass `revealCollection={{ path, seq }}`, pass
`reveal={{ kind: 'collection', path, seq }}` instead. `reveal` also takes
`{ kind: 'entry', path, seq }` for an entry's row and `{ kind: 'changed', seq }` to clear the
query for the Changed filter. `onRevealed` is unchanged. A `reveal` of kind `collection` or
`entry` calls `onChangedOnlyChange(false)`, so a controlled `changedOnly` returns to All.
