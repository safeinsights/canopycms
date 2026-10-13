---
priority: P3
adopters: BOTH
summary: >-
  Small UX follow-ups to the editor's request timeouts. The Retry on the content and branch load toasts hides the toast and drops keyboard focus to `<body>` with nothing showing a retry is running. No story covers a comments surface refusing to close while a write is in flight. The guideline doesn't say where a live status line goes in an overlay, and the collection dialog's unsettled entry-type retries can be refused with a stale list.
---

# Request-timeout UX follow-ups

## What is known

- `RetryToastMessage`'s `onRetry` callers (`useEntryManager.ts`, `useBranchManager.tsx`) hide
  the toast first. Keeping it with `loading` on Retry until the result arrives, or moving focus to
  the content tree or branch list, would follow the keyboard rule in docs/ux-guidelines.md.
- `CloseRefusedNotice` (`editor/comments/CloseRefusedNotice.tsx`) has no story; a
  `CloseWhileSaving` story on CommentsPanel and FieldWrapper with a never-resolving
  `onAddComment` and an Escape play step would cover it.
- docs/ux-guidelines.md covers an unknown outcome's colour and stickiness, but not where a live
  status line goes in an overlay whose title is its `aria-labelledby`.
- The collection dialog (`editor/schema-editor/CollectionEditor.tsx`) settles an unanswered
  entry-type action from one re-read, which can come back before the write finishes. A retry
  that is then refused ("already exists" for an add, "not found" for a remove) leaves the list
  stale, and a refused remove offers a Retry that cannot succeed. Re-read after a refusal that
  follows an unsettled action. Likewise an unsettled update whose entry type is gone from the
  re-read keeps its dialog open inviting a save that will be refused, and Cancel then focuses a
  row that no longer exists; close it with a note and focus the heading instead.

## Done when

Each point above is fixed or ruled out.
