---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-13, left over from resolving member-list-raw-id-without-lookup. `CommentsPanel`, `comments/InlineCommentThread.tsx` and the other comment surfaces fall back to `userIdLabel(userId)`, a raw id, when no `onGetUserMetadata` is passed, against docs/ux-guidelines.md's People rule. `Editor.tsx` always passes one, so only stories and tests render the id. Make the prop required (or render UserBadge with a null lookup) and delete the bare branches.
---
# Comment surfaces show a raw user id without a lookup

[member-list-raw-id-without-lookup.md](resolved/member-list-raw-id-without-lookup.md) removed the
bare-id branches from the group and permission managers. The comment surfaces keep the same
pattern: `CommentsPanel.tsx` (comment author), `comments/InlineCommentThread.tsx` (comment author
and `resolvedBy`) and the components that pass `onGetUserMetadata` down to them
(`FieldWrapper`, `EntryComments`, `BranchComments`, `ThreadCarousel`, `CommentThreadsPopover`)
render `userIdLabel(id)` when the optional lookup is missing.

`userIdLabel` is also the only route by which a system user id reads "CanopyCMS bot" without a
lookup; `UserBadge` already answers system ids itself (`useUserMetadata`), so a required lookup
(or a null one) keeps that.

## Done when

No comment surface renders a user id as a person's label.
