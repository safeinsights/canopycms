---
priority: P3
adopters: BOTH
summary: >-
  RESOLVED (2026-10-14, UX batch 3) — the rebase-failure and base-warning icons in `admin/SystemHealthPanel.tsx` sit in `TooltipDetail`, the focusable trigger the sync-failed badge uses, named and described for assistive tech, with tests that focus each one
---
# System health: rebase-failure and base-warning icons are hover-only

The "Accessibility" section of [docs/ux-guidelines.md](../../../docs/ux-guidelines.md#accessibility)
asks a detail shown only in a tooltip to have a focusable route. `SyncFailedBadge` in
`packages/canopycms/src/editor/admin/SystemHealthPanel.tsx` is the pattern: an `UnstyledButton`
trigger, `aria-describedby` pointing at visually hidden text, and a Tooltip with hover, focus
and touch events. The `ThemeIcon` carrying `data-testid="rebase-failure-<dir>"` and the one that
shows `baseWarning` do not have it.

## Done when

Both messages are reachable by focus, with a test that focuses each trigger.
