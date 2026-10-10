---
priority: P3
adopters: BOTH
summary: >-
  Mantine 7.17's ModalBase listens for Escape on `window` in the capture phase (`use-modal.mjs`), so pressing Escape in a modal opened from inside a drawer also closes the drawer behind it. `BranchesDrawer` and `StagedChangesDrawer` guard this with `closeOnEscape`; the entry-navigator drawer in `Editor.tsx` (entry create, rename, delete modals) and `media/MediaLibrary.tsx`'s manage drawer (its confirms) have not been checked. Audit each drawer, reproduce, and guard where a modal can open on top of it.
---

# Escape in a nested modal can also close the drawer behind it

## What is known

`@mantine/core` 7.17.8, `components/ModalBase/use-modal.mjs`, registers
`useWindowEvent('keydown', …, { capture: true })` and calls `onClose` on Escape whenever
`closeOnEscape && opened`. Every open Drawer and Modal hears the same key press. A drawer whose
own content opens a modal (or `modals.openConfirmModal`) closes along with that modal unless it
sets `closeOnEscape={false}` while the modal is up.

Guarded today:

- `editor/components/BranchesDrawer.tsx` (`confirmOpen` prop).
- `editor/components/StagedChangesDrawer.tsx` (its own confirm, plus `childModalOpen` for the
  group dialog).

Not checked:

- The entry-navigator `Drawer.Root` in `editor/Editor.tsx`: can `EntryCreateModal`,
  `RenameEntryModal` or `ConfirmDeleteModal` open while it is open (narrow layouts)?
- `editor/media/MediaLibrary.tsx` in `'manage'` mode: its delete or other confirms.

## To do

Reproduce each in the browser, then guard the same way, or add one shared way for a drawer to
yield Escape while a modal is open above it.
