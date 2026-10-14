---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-13, from PR 548's UX review. `admin/SystemHealthPanel.tsx` has no Storybook story, so its states (sync failed with a reason, conflicts, rebase failures) are never rendered by the ux-review agent
---

# SystemHealthPanel has no story

The ux-review agent renders Storybook stories to check a diff (docs/ux-guidelines.md,
Enforcement). `SystemHealthPanel` has none, so the sync-failed badge PR 548 made focusable, and
the panel's other states, are only seen in a live walk.

## Fix

Add `SystemHealthPanel.stories.tsx` with mocked health data: a healthy branch, one whose sync
failed with a reason, one in conflict, and a rebase failure.
