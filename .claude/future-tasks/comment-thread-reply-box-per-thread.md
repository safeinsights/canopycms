---
priority: P3
adopters: BOTH
summary: >-
  In the field comment popover (`editor/comments/CommentThreadsPopover.tsx`), every open thread renders `InlineCommentThread`'s reply textarea and a disabled Reply button, so N open threads stack N reply boxes (two fill a 390px screen). Collapse each behind a "Reply" button that expands in place. Natural fit for WS6-lite's inline-reply work, which owns `comments/` after WS4a. Also: `ThreadCarousel.handleAddReply` sets its own error and rethrows to `InlineCommentThread`, which shows it again, so a failed branch reply now shows the message twice.
---

# One reply box per open thread in the comment popover

## What is known

- `InlineCommentThread` always renders the reply `Textarea` and Reply/Resolve buttons for an unresolved thread.
- The popover lists all of a field's threads, so the boxes repeat; the UX review of WS4a (PR 517) flagged it as LOW.
- Reply drafts already live in `CommentThreadsPopover` (`replyDrafts`), so collapsing the box loses nothing typed.
- `ThreadCarousel` (branch comments only, after WS4a) duplicates a failed reply's error: its `handleAddReply` calls `setError` and rethrows, and `InlineCommentThread` catches and shows the same message. Before WS4a the hook swallowed failures, so this never surfaced.

## Done when

An open thread shows a "Reply" button that expands the reply box in place (keeping any draft), and a failed branch reply shows its error once.
