---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-10, from the editor UI epic's WS3 UX review. docs/ux-guidelines.md places toasts bottom-right, but theme.tsx renders `<Notifications position="bottom-left" />`, where the Next.js dev badge covers them in example1; "Comment added" also repeats a visible thread
---
# Editor toasts render bottom-left, against the guideline

docs/ux-guidelines.md says toasts belong bottom-right, away from the rail, and names
`Notifications` in `packages/canopycms/src/editor/theme.tsx` as the owner. That component
renders `<Notifications position="bottom-left" />` (theme.tsx:121). In `apps/example1`'s `/edit`
the Next.js dev badge covers them. "Comment added" also duplicates the thread already on screen.

## Fix

Set `position="bottom-right"` in theme.tsx, and drop toasts that repeat visible state.
