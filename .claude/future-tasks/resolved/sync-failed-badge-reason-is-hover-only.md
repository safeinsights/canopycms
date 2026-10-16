---
priority: P3
adopters: BOTH
summary: >-
  RESOLVED (2026-10-13). `SystemHealthPanel`'s "sync-failed" badge is a `UnstyledButton` trigger described (`aria-describedby`) by visually hidden text holding the reason, with a Tooltip that opens on hover, focus and touch. The panel's rebase-failure and base-warning icons are still hover-only `ThemeIcon`s.
---
# Sync-failed badge: reason is hover-only

## Status: RESOLVED 2026-10-13

`BranchHealthRow` in `packages/canopycms/src/editor/admin/SystemHealthPanel.tsx` wraps the
sync-failed `Badge` in a `Tooltip` that holds `syncFailureReason` and the "retry from the "Tasks"
tab" route. A `Badge` is not focusable, so the text opens on hover only.
[docs/ux-guidelines.md](../../../docs/ux-guidelines.md#accessibility) requires a focusable route for a
detail shown only in a tooltip.

Either make the trigger focusable (a `UnstyledButton` badge, with the tooltip events including
focus and touch) or put the reason in visually hidden text read after the badge via
`aria-describedby`. Test: focus the badge, the reason is present.
