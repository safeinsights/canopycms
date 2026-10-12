---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-11, from PR 532's UX review. SystemHealthPanel's "sync failed" Badge carries the failure reason and the "Tasks" retry route only in a Tooltip on a non-focusable Badge, so a keyboard or touch user never reaches it. It needs a focusable route
---
# Sync-failed badge: reason is hover-only

`BranchHealthRow` in `packages/canopycms/src/editor/admin/SystemHealthPanel.tsx` wraps the
sync-failed `Badge` in a `Tooltip` that holds `syncFailureReason` and the "retry from the "Tasks"
tab" route. A `Badge` is not focusable, so the text opens on hover only.
[docs/ux-guidelines.md](../../docs/ux-guidelines.md#accessibility) requires a focusable route for a
detail shown only in a tooltip.

Either make the trigger focusable (a `UnstyledButton` badge, with the tooltip events including
focus and touch) or put the reason in visually hidden text read after the badge via
`aria-describedby`. Test: focus the badge, the reason is present.
