---
priority: P3
adopters: BOTH
summary: >-
  While `EditorAuthGate`'s signed-out or mode-mismatch overlay is up, it renders inside a second `CanopyCMSProvider` beside the still-mounted Editor, so two `ModalsProvider`s answer every `modals.openConfirmModal`. Clicks are blocked by the overlay, but Escape is not: on a dirty Groups or Permissions drawer, Escape opens "Discard unsaved changes?" twice, above the sign-in overlay, and its Discard still discards behind the wall. Render the gate's overlay without its own `ModalsProvider`, or have the drawers ignore Escape while the gate is active.
---

# The auth gate's overlay brings a second `ModalsProvider`

## What is known

- `editor/EditorAuthGate.tsx` renders its overlay `Modal` (with `closeOnEscape={false}`) in its own
  `CanopyCMSProvider`, a sibling of the Editor's (`editor/Editor.tsx`), and
  `CanopyCMSProvider` (`editor/theme.tsx`) always mounts a `ModalsProvider`.
- `@mantine/modals` 7.17.8 opens a confirm by dispatching a window event, which every mounted
  `ModalsProvider` handles, so each confirm opens once per provider.
- Mantine's ModalBase listens for Escape on `window` in the capture phase, so the drawers behind
  the overlay still hear it. `components/StagedChangesDrawer.tsx` then opens its discard confirm
  if the panel is dirty, above the overlay (the confirm's z-index is `popover`, 300; the overlay is 200).

## To do

Reproduce in the browser: stage a change in Manage Groups, expire the session, press Escape. Then
fix it at the gate (no second `ModalsProvider`), not drawer by drawer.
