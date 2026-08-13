# EntryNavigator's loader keys on "empty tree", so it shows or hides depending on adopter shape

Found while fixing the branch-switch stale-mirror bug
([program-b-final-review-followups.md](resolved/program-b-final-review-followups.md),
HIGH #3, resolved 2026-08-12) — noticed during that work, deliberately left out
of its PR to keep the fix scoped.

## The problem

`editor/EntryNavigator.tsx` renders its loading state only when the whole tree is
empty:

```tsx
{treeData.length === 0 ? (loading ? <Loader …/> : <Text>No content</Text>) : <Tree …/>}
```

`treeData` is built from the `collections` prop, which `Editor.tsx` supplies as
`activeCollections` — and that is
`collectionsFromApi.length > 0 ? collectionsFromApi : collections`, i.e. it falls
back to the adopter's build-time `collections` prop whenever the fetched list is
empty.

Since the branch-switch fix, the fetched list *is* empty during a switch (that is
the point — it is how another branch's data is kept off screen). So during the
switch window the navigator behaves differently depending on something the
adopter chose:

- **Adopter passes `collections`** (the first-party path): `treeData` is
  non-empty — entry-less folders from the build-time schema — so the loader never
  fires. The user sees a folder tree with no entries and no indication anything
  is loading.
- **Adopter passes none**: `treeData` is empty, and the loader shows correctly.

The editor *pane* shows "Loading content…" in both cases (`Editor.tsx` consults
`entriesInitializing` when `!currentEntry`), so this is specifically the
navigator being inconsistent with the pane beside it.

## Fix direction

Key the loader on "no entry items" rather than "no tree nodes" — during a load
the tree may legitimately have folder nodes and still have nothing to select.
Either count entry-type nodes in `treeData`, or pass the entry count alongside
`loading` so `EntryNavigator` doesn't have to re-derive it.

Worth checking at the same time whether the folder-only tree should render at all
mid-switch: those folders come from the adopter's build-time schema, not from the
branch being switched to, so a branch with a different schema shows the wrong
folders briefly.

## Not urgent

Cosmetic — no data is at risk, and the editor pane already tells the user
something is happening. Filed because it is the kind of detail that is expensive
to re-derive: the interaction between `activeCollections`' prop fallback and the
navigator's empty-tree test is not obvious from either file alone.
