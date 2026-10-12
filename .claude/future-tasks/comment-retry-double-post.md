---
priority: P3
adopters: BOTH
summary: >-
  Two comment-write gaps in `editor/hooks/useCommentSystem.ts`. `handleAddComment` reports `COMMENT_NOT_ADDED` whenever the POST's response is lost (`.catch(() => null)`), even when the server stored the comment, so the natural retry posts it twice. And a reload that fails after a successful post never rejects: `fetchComments` (`hooks/useCommentsData.ts`) returns an empty list, which `loadComments` writes over the cached threads, blanking them.
---

# A retried comment can post twice, and a failed reload blanks the threads

## What is known

- `handleAddComment` turns any failure of `apiClient.comments.add`, including a network error
  after the server already stored the comment, into the same `COMMENT_NOT_ADDED` rejection.
  `comments/ThreadReplyControls.tsx` and the composers keep the text on that rejection, so
  retrying can duplicate the comment.
- `fetchComments` logs and returns `{ threads: [], users: [] }` on any failure, and
  `loadComments` writes that result into the `canopy:comments:<branch>` cache with
  `revalidate: false`, so one failed reload empties every comment surface until the next load.

## Done when

A retry after a lost response cannot duplicate a comment (an idempotency key, or a check for the
just-posted comment), and a failed reload keeps the threads already shown.
