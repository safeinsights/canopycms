---
priority: P3
adopters: NEITHER
summary: >-
  Code only: docs/ux-guidelines.md now rules on the field comment control and on popovers over their own field. The comment popover can still cover its field's input, and the comment control's visibility and tab order don't yet match the rule.
---
# Field comment control: code left after the WS4a guideline rulings

The rules are in [docs/ux-guidelines.md](../../docs/ux-guidelines.md): Fields for the comment
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
