---
priority: P3
adopters: BOTH
summary: >-
  RESOLVED (2026-10-13). The comments panel's refusal to close already said why (`CloseRefusedNotice`); this pass added the missing test for the X. `StagedChangesDrawer`'s confirm now reads "Discard changes" / "Keep editing". New stories: `CommentsPanel` `WithJumpButtons` and `WriteInFlight` (a never-settling `onAddComment` shows the blocked jumps and the refusal), and `EditorSidebar` `SettingsMenuOpen` / `SettingsMenuForEditor` (a `play` function opens the menu).
---
# Comments panel and staged-drawer UX follow-ups

## Status: RESOLVED 2026-10-13

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
