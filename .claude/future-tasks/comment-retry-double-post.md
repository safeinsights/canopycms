---
priority: P3
adopters: BOTH
summary: >-
  `useCommentSystem.handleAddComment` (`editor/hooks/useCommentSystem.ts`) throws "Couldn't add the comment" when the POST succeeded but the reload after it failed. The reply box keeps the text and shows that error, so the natural retry posts the reply a second time. Treat a reload failure after a successful post separately (keep the post, say the list couldn't refresh).
---

# A retried comment can post twice

## What is known

- `handleAddComment` awaits `apiClient.comments.add`, then `loadComments`; a rejection from
  either reaches the caller as the same `COMMENT_NOT_ADDED` error.
- `comments/ThreadReplyControls.tsx` and the comment composers keep the text on any rejection,
  which is right for a failed post and wrong for a failed reload.

## Done when

A post that succeeded never reads as failed, so retrying can't duplicate it.
