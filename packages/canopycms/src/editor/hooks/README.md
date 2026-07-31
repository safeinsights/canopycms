# Editor Hooks Architecture

## SWR-Backed Data Loading

Each fetch-on-load resource (branches, entries+schema, comments) has a
dedicated SWR-backed data hook that owns the automatic on-mount/on-branch-change
fetch:

- `useBranchesData` (`useBranchesData.ts`) -- GET /branches, key `canopy:branches`
- `useEntriesData.ts` -- GET /:branch/schema + GET /:branch/entries (paginated),
  key `canopy:entries:${branch}`. Fetch/key pieces only, no wrapper hook:
  `useEntryManager` owns the sole `useSWR` call for these keys, because its
  cache slots hold TAGGED values (`{ fetched, seq, branch }`) for its
  out-of-order commit guard -- see the note at the bottom of that file
- `useCommentsData` (`useCommentsData.ts`) -- GET /:branch/comments, key
  `canopy:comments:${branch}`

The corresponding manager hook (`useBranchManager`, `useEntryManager`,
`useCommentSystem`) consumes its data hook's reactive `data`/`error`/
`isValidating` and mirrors them onto its own state/busy flags via `useEffect`.
This is what replaced each hook's own `useEffect([branchName])` fetch — see
`.claude/future-tasks/resolved/swr.md` for the removed pattern and the
2026-07-24 decision to adopt SWR.

### Why this fixes the duplicate-request problem

SWR dedupes concurrent requests to the same cache key within
`dedupingInterval` (`SWRProvider`, in `../context/SWRProvider.tsx`). That
collapses:

- React Strict Mode's mount → cleanup → remount cycle, which used to fire
  each hook's fetch twice in dev
- Editor.tsx's `availableSchemas` picker, which used to run its own separate
  schema fetch on the same branch change `useEntryManager.refreshEntries`
  already triggers — it now reads `availableSchemas` off `useEntryManager`'s
  return value instead (the schema fetch and the entries fetch are the same
  request; see `useEntriesData.fetchEntriesAndSchema`)

### Explicit reload vs. automatic load

Each manager hook's imperative reload function (`loadBranches`,
`loadComments`, `useEntryManager.refreshEntries`) does **not** call SWR's
`mutate(key)` revalidate form. It fetches directly (an independent,
un-deduped network call — callers that just mutated content need to see
their own write reflected immediately, not coalesced with a
still-in-flight automatic load) and then writes the result into the SWR
cache with `mutate(key, data, { revalidate: false })`. That keeps the
bound data hook's reactive `data` in sync without a second request.

`useEntryManager.refreshEntries` additionally guards every commit (from
both the automatic load and explicit calls) with a shared monotonic
`refreshSeqRef` counter, so overlapping calls resolve "last caller wins"
regardless of response order — see the doc comment on `refreshSeqRef` in
`useEntryManager.ts`.

### Testing

Hook tests wrap `renderHook` with an **isolated** SWR cache
(`SWRConfig value={{ provider: () => new Map() }}`) via
`createApiClientWrapper` in `__test__/test-utils.tsx`, so test cases don't
share cache state through SWR's real global cache.

### Flow

Branch switch → `branchName` state changes → each data hook's key changes →
SWR fetches the new key automatically (previous key's cache slot is
untouched, so a slow response for the branch you switched away from can
never land in the new branch's state):

- `useBranchesData` is NOT branch-keyed (the branches list isn't
  branch-scoped data), so a branch switch does not re-fetch it
- the entries and comments keys re-key and re-fetch per branch
