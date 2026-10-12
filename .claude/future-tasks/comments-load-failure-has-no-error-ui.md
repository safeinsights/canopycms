---
priority: P3
adopters: BOTH
summary: >-
  A branch's comment list that fails to load (an error status, or a read past the API client's deadline) shows no error and no Retry. `useCommentsData` rejects and SWR keeps any threads already shown, but on a first load the comments panel, the field popovers and the entry button read as "no comments" with nothing saying otherwise. Surface the load error with a Retry in the comments panel, per docs/ux-guidelines.md's states rules.
---

# A failed comment-list load reads as "no comments"

## What is known

- `fetchComments` (`editor/hooks/useCommentsData.ts`) rejects on a failed read, and
  `useCommentsData` logs it through SWR's `onError`. The `error` it returns is unused:
  `useCommentSystem` reads only `data`.
- `useCommentSystem.loadComments` logs a failed reload and keeps the threads already shown.
- With `shouldRetryOnError: false` (`editor/context/SWRProvider.tsx`) the failure is terminal
  until the key is revalidated, by a write's reload, a branch switch or a re-sign-in.

## Done when

A failed first load of comments shows what failed and a Retry where the threads would be.
