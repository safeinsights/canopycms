---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-10, from the editor UI epic's WS0. The System Health branch table takes its status colours from `editor/branch-status.ts` but still shows the raw status ("submitted"), while the header and Branches drawer show the shared labels ("In review"). Its e2e specs read the raw text, so switching means moving them to a `data-status` attribute first
---
# System Health shows raw branch statuses

`editor/admin/SystemHealthPanel.tsx`'s branch table renders `{b.status}` in a badge coloured from
`branchStatusPresentation(b.status)`. Every other branch-status badge renders the shared label.

To finish it:

- Add `data-status={b.status}` to that badge and render `branchStatusPresentation(b.status)?.label`.
- Move `apps/test-app/e2e/tests/admin-branch-health.spec.ts`'s status-text assertions to the
  attribute, the way `fixtures/branch-page.ts`'s `verifyBranchStatus` does.

Fits WS7b (admin UIs) in [ui-epic-202610.md](ui-epic-202610.md).
