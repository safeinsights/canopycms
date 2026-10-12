---
priority: P3
adopters: NEITHER
summary: >-
  RESOLVED (2026-10-11): the field comment popover never covers its field's input: it opens below a short field, above the label row of a group or tall field, and on the other side when only that has room (`editor/comments/popover-placement.ts`). The idle control shows unhovered only while the field has open threads and is out of the tab order. The form's one keyboard route reaches comments instead: Mod+Alt+M on the focused field, or the "Field comments" menu (`editor/comments/form-comments.tsx`), which lists the fields with threads, resolved ones included, and every field.
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
