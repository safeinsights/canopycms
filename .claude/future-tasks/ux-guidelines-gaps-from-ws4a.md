---
priority: P3
adopters: NEITHER
summary: >-
  Four places where `docs/ux-guidelines.md` is silent, found by the WS4a UX review (PR 517): whether an empty-input submit button needs a disabled reason, popover placement over its own field, the field comment control's behaviour, and the colour of count badges. Proposed wording below; the doc is word-budgeted (`pnpm lint:docs`), so each addition needs a trim or a budget ruling.
---

# Guideline gaps found by the WS4a UX review

Proposed wording, for a decision rather than to apply as-is:

- **Disabled says why.** "A submit button that waits only on its own visible input may be disabled without a tooltip; any other disabled control says why." Comment and Reply are disabled until their box has text, with no tooltip.
- **Choosing a surface.** "A popover anchored to a field never covers that field's input." WS4a opens the field comment popover above the label row for this reason.
- **Fields.** "The comment control follows the label: hidden until the field is hovered or focused, still in the tab order, and a persistent count while open threads exist."
- **Colour.** "Counts use the text colour on a tinted background and meet 4.5:1." The guidelines give colour meanings (green, blue, yellow, red) but say nothing of orange count badges.
