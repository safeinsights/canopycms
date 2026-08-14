# [P2] No UI triggers the duplicate-content-ID repair action

Raised by the human review of
[PR #229](https://github.com/safeinsights/canopycms/pull/229#pullrequestreview-4938780868)
(finding #4), 2026-08-14. The **diagnosis** half is now done; the **action** half is not.

## What exists

- `packages/canopycms/src/api/admin-branch-health.ts` —
  `POST /admin/branch-dirs/:dirName/repair-content-duplicates`, admin-guarded, archives the
  quarantined (losing) file(s) under a dot-prefixed name and never touches the winner. The
  generated client method exists.
- `packages/canopycms/src/branch-health.ts` — `BranchHealthEntry.duplicateContentIds`.
- `packages/canopycms/src/editor/admin/SystemHealthPanel.tsx` — a **read-only** `N duplicate
  IDs` badge on each affected healthy branch row, tooltip listing `contentId: paths`. No
  button.

## What is missing, and why it was left out

Nothing invokes `repairContentDuplicates` from any UI. The obvious home for the trigger is
the branch-health row — which is also where **Purge** lives, and Purge trashes the entire
branch directory. Putting a duplicate-repair button in that row risks a misroute with a
catastrophic neighbour, so the button was deliberately not added.

Before this, `DuplicateContentIdError`'s message told the editor "an admin can resolve it
with the repair-content-duplicates action for this branch" — an action that admin could
neither run nor even see applied to their branch. The message now names the state instead
("an administrator needs to resolve the duplicate on the server"), which is true, and the
read-only badge closes the diagnosis gap.

## Fix direction

Give the repair its own confirmed surface, away from Purge: a detail view or modal opened
from the duplicate badge, showing kept path vs. dropped path(s) and what archiving does,
with its own confirmation. `SystemHealthPanel.tsx` already has the confirm-modal pattern
(`modals.openConfirmModal`) used by purge/repair-metadata.

Two things to carry into that work:

- Unit suites mock `@mantine/modals` wholesale, so a new confirmation dialog is
  **structurally invisible** to them — this needs an e2e assertion, not just a unit test.
- `scanDuplicateContentIds` is expensive per request; if it gets gated behind a query flag
  (see item 2 of [pr229-review-followups.md](pr229-review-followups.md)), this UI has to
  pass the flag.
