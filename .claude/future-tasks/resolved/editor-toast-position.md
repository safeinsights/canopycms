---
priority: P3
adopters: BOTH
summary: >-
  RESOLVED (2026-10-11) — superseded. JP ruled toasts go in the corner opposite the rail, which theme.tsx's `position="bottom-left"` already meets, and docs/ux-guidelines.md now says so. The "Comment added" toast is gone from the editor. example1's dev badge covering toasts moved to [filled-button-contrast-and-toast-guidelines.md](../filled-button-contrast-and-toast-guidelines.md).
---
# Editor toasts render bottom-left, against the guideline

docs/ux-guidelines.md says toasts belong bottom-right, away from the rail, and names
`Notifications` in `packages/canopycms/src/editor/theme.tsx` as the owner. That component
renders `<Notifications position="bottom-left" />` (theme.tsx:121). In `apps/example1`'s `/edit`
the Next.js dev badge covers them. "Comment added" also duplicates the thread already on screen.

## Fix

Set `position="bottom-right"` in theme.tsx, and drop toasts that repeat visible state.
