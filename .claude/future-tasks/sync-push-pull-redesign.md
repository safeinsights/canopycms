# Sync Push/Pull Semantics Redesign

## Problem

The current `canopycms sync` CLI has an asymmetry between push and pull:

- **Push** copies working-tree content into `remote.git` (the local bare remote), then fetches in existing branch workspaces. This is like a "publish" — it updates the authoritative content source.
- **Pull** copies a branch workspace's content into the working tree. It does NOT pull from `remote.git`.

This asymmetry means:

1. Push and pull don't operate on the same data path (push → remote.git, pull ← branch workspace).
2. `--direction=both` is confusing: push updates remote.git and fetches in branch workspaces, but the branch workspace hasn't rebased/merged yet, so pull copies back the pre-push state.
3. The word "push" implies "push to a remote" but it's really "update the content source that branch workspaces clone from."

## Questions to Resolve

- Should push go to `remote.git`, to a branch workspace, or both?
- Should pull come from `remote.git`, from a branch workspace, or should it depend on context?
- Is `--direction=both` a valid use case? If so, what should the semantics be?
- Should there be a rebase/merge step between push and pull in the `both` flow?
