---
priority: P3
adopters: NEITHER
summary: >-
  Questions for the maintainer from the UX review of the batch 3 behaviour PR, where docs/ux-guidelines.md is silent: how keyboard focus reaches an Undo toast, where focus goes when a button removes itself (Clear), camelCase acronyms in humanised names, a way forward on "You can't add entries here", and "comments" versus "threads" in counts
---

# UX guideline gaps from batch 3

Each needs a ruling in [docs/ux-guidelines.md](../../docs/ux-guidelines.md) before code follows.

- **Reaching an Undo toast.** It sits in a portal at the end of the Tab order with no shortcut;
  the guidelines cover pausing it on focus, not getting there.
- **A control that removes itself.** Clear now hands focus to its object
  (`fields/ObjectField.tsx`), as Remove hands it to the list; [Keyboard](../../docs/ux-guidelines.md#keyboard)
  covers openers and menu items only.
- **Acronyms in humanised names.** `humanizeName` reads `ctaText` as "Cta text"; the rule could
  tell adopters to label such fields.
- **"You can't add entries here."** The [Disabled controls](../../docs/ux-guidelines.md#disabled-controls)
  example names no way forward, which "Disabled says why" otherwise asks for (the form's
  no-access notice names "Manage permissions").
- **Comments or threads.** Counts say "comment thread" in the Remove toast and the "Field
  comments" menu, "open thread" in the entry button's label, and "threads" in the comments panel.
