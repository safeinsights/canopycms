# Plan: Reduce Duplicate API Requests with SWR

**Status**: Deferred
**Priority**: Low-Medium
**Created**: 2024-12-27

---

## Problem

On initial `/edit` page load, we see 15+ API requests when there should be 3 (one per endpoint):
- GET /api/canopycms/branches (called 5+ times)
- GET /api/canopycms/{branch}/entries (called 5+ times)
- GET /api/canopycms/{branch}/comments (called 5+ times)

### Root Causes

1. **React Strict Mode** (`reactStrictMode: true` in next.config.mjs) - runs effects twice in development
2. **Three independent hooks with separate useEffects** - each has `branchName` dependency:
   - `useBranchManager.tsx` lines 206-208: `useEffect(() => loadBranches(), [branchName])`
   - `useEntryManager.ts` lines 166-177: `useEffect(() => refreshEntries(branchName), [options.branchName])`
   - `useCommentSystem.ts` lines 224-230: `useEffect(() => loadComments(branchName), [options.branchName])`
3. **No request deduplication** - concurrent fetches to same URL all execute
4. **State updates causing cascading re-renders**

---

## Solution

Add SWR (~4KB) for automatic request deduplication, caching, and Strict Mode compatibility.

---

## Files to Create

### 1. `packages/canopycms/ARCHITECTURE.md`
Document architectural decisions for agents and developers:

```markdown
# CanopyCMS Architecture Decisions

This document captures key architectural decisions to guide consistent development.

## Data Fetching

**Decision**: Use SWR for all client-side data fetching in the Editor.

**Why**:
- Automatic request deduplication (prevents duplicate concurrent fetches)
- Works correctly with React Strict Mode
- Built-in caching and revalidation
- Small bundle size (~4KB)

**Pattern**:
- Create SWR hooks in `src/editor/hooks/` named `use{Resource}Data.ts`
- Use these hooks in existing manager hooks (`useBranchManager`, `useEntryManager`, etc.)
- Call `mutate()` after mutations to revalidate

**Don't**:
- Don't use raw `fetch()` + `useEffect` for data fetching in the Editor
- Don't create multiple independent effects that fetch the same data
```

### 2. `packages/canopycms/src/editor/api/fetcher.ts`
Standard SWR fetcher utilities with error handling.

### 3. `packages/canopycms/src/editor/api/SWRProvider.tsx`
SWR configuration provider with settings:
- `revalidateOnFocus: false`
- `dedupingInterval: 2000`

### 4. `packages/canopycms/src/editor/hooks/useBranchesData.ts`
SWR hook for `/api/canopycms/branches`

### 5. `packages/canopycms/src/editor/hooks/useEntriesData.ts`
SWR hook for `/api/canopycms/{branch}/entries`

### 6. `packages/canopycms/src/editor/hooks/useCommentsData.ts`
SWR hook for `/api/canopycms/{branch}/comments`

---

## Files to Modify

### 1. `packages/canopycms/package.json`
Add `"swr": "^2.2.5"` to dependencies.

### 2. `packages/canopycms/src/editor/Editor.tsx`
Wrap content with `<SWRProvider>`.

### 3. `packages/canopycms/src/editor/hooks/useBranchManager.tsx`
- Import and use `useBranchesData()`
- Remove `useEffect` at lines 206-208 that calls `loadBranches()`
- Replace `loadBranches` calls with SWR's `mutate()` for revalidation after mutations

### 4. `packages/canopycms/src/editor/hooks/useEntryManager.ts`
- Import and use `useEntriesData(branchName)`
- Remove `useEffect` at lines 166-177 that calls `refreshEntries()`
- Keep branch-change logic for clearing selection (use ref to detect change)

### 5. `packages/canopycms/src/editor/hooks/useCommentSystem.ts`
- Import and use `useCommentsData(branchName)`
- Remove `useEffect` at lines 224-230 that calls `loadComments()`
- Replace `loadComments` calls with SWR's `mutate()` after add/resolve

### 6. `packages/canopycms/src/editor/hooks/index.ts`
Export new SWR hooks.

### 7. `AGENTS.md`
Add reference to ARCHITECTURE.md in working agreements section.

---

## Implementation Steps

1. Install SWR dependency
2. Create ARCHITECTURE.md
3. Create fetcher utilities and SWR provider
4. Create the three SWR data hooks
5. Refactor `useBranchManager` to use `useBranchesData`
6. Refactor `useEntryManager` to use `useEntriesData`
7. Refactor `useCommentSystem` to use `useCommentsData`
8. Wrap Editor with SWR provider
9. Update AGENTS.md
10. Run typecheck and tests
11. Manual verification: load `/edit` and confirm only 3 API calls

---

## Verification

After implementation, loading `/edit` should show in Network tab:
```
GET /api/canopycms/branches       (1 request)
GET /api/canopycms/main/entries   (1 request)
GET /api/canopycms/main/comments  (1 request)
```

Instead of the current 15+ requests.

---

## Notes

- The duplicate requests don't break functionality, just add latency and server load
- This is a performance optimization, not a bug fix
- Can be deferred until after higher priority items are complete
