# Branch dialogs and draft verification: follow-ups

## Priority: P3 [BOTH]

The unsaved-changes confirm on branch create and switch now counts only drafts that really differ
from the server. It also runs before the create spinner, and holds the Branches drawer's Escape
(`editor/hooks/useBranchActions.tsx`, `useDraftManager.ts`, `components/BranchesDrawer.tsx`).
Review left three gaps.

1. **The drawer's other confirms still lose the drawer on Escape.** Submit, Withdraw and Delete
   (`useBranchManager.tsx`) open confirms from the same drawer. Escape closes the drawer underneath
   them, because Mantine listens for Escape on the window, in the capture phase. Give them the same
   `confirmOpen` hand-off the unsaved-changes confirm has.
2. **The confirm can wait out the full cap.** If the selected entry's own load fails, its restored
   draft is never verified: verification leaves the selected entry to its own load. Every branch
   switch or create then waits the full 3 s cap before the confirm appears. Mark the draft
   unreadable when the selected entry's load fails.
3. **Leftovers count as unsaved while the entry list loads.** While a branch's entry list has not
   arrived (`entriesKnown` false), a switch or create counts that branch's pristine leftovers as
   unsaved. The dialog then shows "You have unsaved changes." with no labels. This is transient, and
   errs on the conservative side.
