---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-13. In `admin/SystemHealthPanel.tsx`, `BranchHealthRow`'s rebase-failure icon and the base-branch warning icon are non-focusable `ThemeIcon`s whose message is in a Tooltip only, so a keyboard or touch user never reaches it. The "sync-failed" badge beside them was fixed in the same file (`SyncFailedBadge`); these two need the same focusable route.
---
# System health: rebase-failure and base-warning icons are hover-only

The "Accessibility" section of [docs/ux-guidelines.md](../../docs/ux-guidelines.md#accessibility)
asks a detail shown only in a tooltip to have a focusable route. `SyncFailedBadge` in
`packages/canopycms/src/editor/admin/SystemHealthPanel.tsx` is the pattern: an `UnstyledButton`
trigger, `aria-describedby` pointing at visually hidden text, and a Tooltip with hover, focus
and touch events. The `ThemeIcon` carrying `data-testid="rebase-failure-<dir>"` and the one that
shows `baseWarning` do not have it.

## Done when

Both messages are reachable by focus, with a test that focuses each trigger.
