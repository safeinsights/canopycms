# Editor Hooks Architecture

## Decoupled Reactive Pattern

Hooks independently manage their data lifecycle using `useEffect` to watch `branchName`.

### Principles
- Each hook owns its data loading via `useEffect([branchName])`
- No callback orchestration between hooks
- State flows down from `useBranchManager.branchNameState`
- Effects fire in parallel when `branchName` changes

### Flow
Branch switch → `branchName` state changes → 3 parallel effects:
- `useBranchManager` → `loadBranches()`
- `useEntryManager` → `refreshEntries()`
- `useCommentSystem` → `loadComments()`

### Benefits
- Self-contained hooks (easier testing)
- Parallel data loading (better performance)
- No duplicate requests (each hook loads once)
