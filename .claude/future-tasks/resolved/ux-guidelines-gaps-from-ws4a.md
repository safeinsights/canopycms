---
priority: P3
adopters: NEITHER
summary: >-
  RESOLVED (2026-10-11): the field comment popover opens below its field's input and never flips over it; the idle control shows unhovered only while the field has open threads and is out of the tab order; and the form's one keyboard route reaches comments instead: Mod+Alt+M on the focused field, or the "Comments in this form" menu (`editor/comments/form-comments.tsx`), which lists the fields with threads, resolved ones included, and can start one on the field last focused.
---
# Field comment control: code left after the WS4a guideline rulings

The rules are in [docs/ux-guidelines.md](../../../docs/ux-guidelines.md): Fields for the comment
control, Choosing a surface for popovers.

1. **Popover over its own field.** `packages/canopycms/src/editor/comments/CommentThreadsPopover.tsx`
   opens above the label row, but flips below, over the input, when there is no room above.
   Anchor it below the input.
2. **Visibility.** The control stays in view whenever the field has any thread, resolved ones
   included (`shown` in `CommentThreadsPopover.tsx`). The rule shows it unhovered only while
   threads are open.
3. **Tab stop.** The idle control is to leave the tab order (`tabIndex={-1}`) once one
   per-form keyboard route to comments exists, a shortcut or menu. Build that route first,
   then drop the Tab stop.
