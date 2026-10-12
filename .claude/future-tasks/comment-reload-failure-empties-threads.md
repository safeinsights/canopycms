---
priority: P3
adopters: BOTH
summary: >-
  `fetchComments` (`editor/hooks/useCommentsData.ts`) answers a failed list request with `{ threads: [] }`, and `useCommentSystem`'s `loadComments` writes that into the SWR cache after every add or resolve. One failed reload after a successful post therefore makes every thread on the branch vanish from the form, the badges and the Comments panel until the next revalidation. Keep the previous data on a failed reload (throw, or skip the cache write) and show a load error instead.
---

# A failed comment reload empties every thread

## What is known

- `fetchComments` catches both a non-ok result and a thrown error, logs `Failed to load comments:` and returns `{ threads: [] }`.
- `loadComments` passes that result to `globalMutate(commentsKey(branch), fresh, { revalidate: false })`, replacing the cached threads.
- `handleAddComment` and `handleResolveThread` call `loadComments` after a successful write, so a transient list failure right after posting hides all comments, though the post landed.
- The add has landed by then, so the fix must not surface the reload failure as
  `COMMENT_NOT_ADDED` from `handleAddComment`: the composer would keep the text and invite a
  duplicate post. Report it as a load error instead.

## Done when

A failed reload leaves the cached threads in place and the failure is visible, with a test that mocks the list call failing after a successful add.
