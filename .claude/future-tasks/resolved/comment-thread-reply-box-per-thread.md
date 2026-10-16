---
priority: P3
adopters: BOTH
summary: >-
  RESOLVED (2026-10-11) — in WS6-lite. An open thread in the comment popover, ThreadCarousel and the Comments panel shows a "Reply…" button that expands its own reply box in place, keeping any draft; Resolve tracks loading per thread. The duplicated branch-reply error is gone: ThreadCarousel passes a failed reply straight through, and `ThreadReplyControls` shows it once.
---

# One reply box per open thread in the comment popover

## What is known

- `InlineCommentThread` always renders the reply `Textarea` and Reply/Resolve buttons for an unresolved thread.
- The popover lists all of a field's threads, so the boxes repeat; the UX review of WS4a (PR 517) flagged it as LOW.
- Reply drafts already live in `CommentThreadsPopover` (`replyDrafts`), so collapsing the box loses nothing typed.
- `ThreadCarousel` (branch comments only, after WS4a) duplicates a failed reply's error: its `handleAddReply` calls `setError` and rethrows, and `InlineCommentThread` catches and shows the same message. Before WS4a the hook swallowed failures, so this never surfaced.

## Done when

An open thread shows a "Reply" button that expands the reply box in place (keeping any draft), and a failed branch reply shows its error once.
