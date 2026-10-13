---
priority: P3
adopters: BOTH
summary: >-
  Small UX follow-ups to the editor's request timeouts. A renamed entry that landed after no answer loses its selection, and a read-only POST that times out says it may have gone through. A comment post that "may have been posted" shows as a red error, where the guideline rules yellow. The Retry on the content and branch load toasts hides the toast and drops keyboard focus to `<body>` with nothing showing a retry is running. No story covers a comments surface refusing to close while a write is in flight. The sticky "save may have landed" toast names no entry, which the guideline requires, and the collection dialog's unsettled entry-type retries can be refused with a stale list.
---

# Request-timeout UX follow-ups

## What is known

- `COMMENT_MAY_BE_ADDED` (`editor/hooks/useCommentSystem.ts`) reaches the composers' `error`
  state, shown in red: a red `Alert` under a reply (`editor/comments/ThreadReplyControls.tsx`)
  and the new-thread box's field error (`NewThreadComposer` in `CommentThreadsPopover.tsx`).
  docs/ux-guidelines.md has unknown outcomes in yellow, comment posts included, so the composers
  need to know the outcome is uncertain.
- `RetryToastMessage`'s `onRetry` callers (`useEntryManager.ts`, `useBranchManager.tsx`) hide
  the toast first. Keeping it with `loading` on Retry until the result arrives, or moving focus to
  the content tree or branch list, would follow the keyboard rule in docs/ux-guidelines.md.
- `CloseRefusedNotice` (`editor/comments/CloseRefusedNotice.tsx`) has no story; a
  `CloseWhileSaving` story on CommentsPanel and FieldWrapper with a never-resolving
  `onAddComment` and an Escape play step would cover it.
- A rename that got no answer but landed reloads the content tree (`useEntryManager.renameEntry`);
  the old path is then gone, so the selection falls back to the first entry instead of the
  renamed one. Selecting the refreshed entry with the same `contentId` would keep the user there.
- `ApiTimeoutError` picks its message by method, so a read-only POST (`assets.presign`,
  `content.resolveReferences`, `permissions.batchGetUserMetadata`) that times out says it "may
  have gone through". Route metadata could mark such endpoints as reads.
- docs/ux-guidelines.md covers an unknown outcome's colour and stickiness, but not where a live
  status line goes in an overlay whose title is its `aria-labelledby`.
- The "may already have gone through" save toast (`showSaveMayHaveLanded` in
  `editor/hooks/useDraftManager.ts`) stays up while the user opens other entries, and names none,
  so its "Reload entry" instruction reads as being about whichever entry is open. The guideline
  has it name its entry.
- The collection dialog (`editor/schema-editor/CollectionEditor.tsx`) settles an unanswered
  entry-type action from one re-read, which can come back before the write finishes. A retry
  that is then refused ("already exists" for an add, "not found" for a remove) leaves the list
  stale, and a refused remove offers a Retry that cannot succeed. Re-read after a refusal that
  follows an unsettled action. Likewise an unsettled update whose entry type is gone from the
  re-read keeps its dialog open inviting a save that will be refused, and Cancel then focuses a
  row that no longer exists; close it with a note and focus the heading instead.

## Done when

Each point above is fixed or ruled out.
