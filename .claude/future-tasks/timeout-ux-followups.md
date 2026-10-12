---
priority: P3
adopters: BOTH
summary: >-
  Small UX follow-ups to the editor's request timeouts. A comment post that "may have been posted" shows in the composer's red error Alert, where save and branch outcomes use yellow. The Retry on the content and branch load toasts hides the toast and drops keyboard focus to `<body>` with nothing showing a retry is running. No story covers a comments surface refusing to close while a write is in flight. And the guidelines do not yet say how an unknown outcome (a write that may have landed) is shown.
---

# Request-timeout UX follow-ups

## What is known

- `COMMENT_MAY_BE_ADDED` (`editor/hooks/useCommentSystem.ts`) reaches the composers' `error`
  state, shown as a red `Alert` (`editor/comments/ThreadReplyControls.tsx` and the popover's
  `NewThreadComposer`). A warning colour needs the composers to know the outcome is uncertain.
- `RetryToastMessage`'s `onRetry` callers (`useEntryManager.ts`, `useBranchManager.tsx`) hide
  the toast first. Keeping it with `loading` on Retry until the result arrives, or moving focus to
  the content tree or branch list, would follow the keyboard rule in docs/ux-guidelines.md.
- `CloseRefusedNotice` (`editor/comments/CloseRefusedNotice.tsx`) has no story; a
  `CloseWhileSaving` story on CommentsPanel and FieldWrapper with a never-resolving
  `onAddComment` and an Escape play step would cover it.
- docs/ux-guidelines.md says nothing about an unknown outcome's colour, whether it is sticky, or
  that it must not say "try again"; nor where a live status line goes in an overlay whose title
  is its `aria-labelledby`.

## Done when

Each point above is fixed or ruled out, and the guidelines cover unknown outcomes.
