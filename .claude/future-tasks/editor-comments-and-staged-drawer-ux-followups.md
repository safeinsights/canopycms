---
priority: P3
adopters: BOTH
summary: >-
  Leftovers from PR 538's UX review. The comments panel ignores Esc and its X while a write is in flight and doesn't say why. The staged drawers' unsaved-changes confirm says "Discard" / "Keep editing" instead of repeating "Discard changes". No CommentsPanel story renders the jump buttons or their blocked state, and no EditorSidebar story opens the Settings menu.
---

# Comments panel and staged-drawer UX follow-ups

All of these predate PR 538; its UX review found them next to the changed flows.

- **Silent refusal to close.** `packages/canopycms/src/editor/CommentsPanel.tsx` refuses to
  close while `inFlight > 0` (a comment add, reply or resolve hasn't settled), and Esc and the X
  do nothing visibly. The jump buttons beside them explain the same wait in a tooltip. Say why,
  for example with a tooltip on the X or a short inline note.
- **Confirm labels.** `components/StagedChangesDrawer.tsx`'s unsaved-changes confirm uses
  "Discard" / "Keep editing". The Destructive actions rule asks the red button to repeat the
  verb ("Discard changes").
- **Stories.** No `CommentsPanel` story passes `onJumpTo*`, so the jump buttons and their
  blocked state (a never-resolving `onAddComment`) are never shown. No `EditorSidebar` story
  opens the Settings menu.

## Done when

The panel says why it won't close, the confirm repeats its verb, and both stories exist.
