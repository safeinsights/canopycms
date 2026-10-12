---
priority: P3
adopters: NEITHER
summary: >-
  RESOLVED (2026-10-11) — JP's rulings, written into docs/ux-guidelines.md: a card's primary action by role (Copy), disabled reasons on focus and touch and `aria-disabled` menu items (Disabled controls), "…" only for commands that ask for more input (Copy), a form's confirm may name its noun (Copy), and focus falling back to the nearest list heading or search field (Keyboard). Omitted on purpose: moving focus only when the user has not moved it since Resolve stays a code-level rule.
---

# UX guideline gaps surfaced by WS6-lite

## What WS6-lite decided (so the guideline can confirm or overrule)

- Reviewer on someone else's submitted branch: Request changes is the card's primary action.
- Disabled-with-reason Tooltips open on hover, focus and touch.
- Disabled menu items keep `aria-disabled` (not `disabled`) so arrow keys reach them, with the
  reason as a second line in the item.
- Submit for review, Withdraw from review and Delete branch open confirms and take no "…";
  "New branch…", "Switch branch…" and "Reply…" ask for more and do.
- A branch card's button says "Open"; the create form's confirm says "Create branch".
- Resolving a thread that leaves a list moves focus to the list's count heading; one that stays
  moves focus to its own heading; either only when the user hasn't moved focus since clicking
  Resolve.

## Done when

Each point is either written into docs/ux-guidelines.md or recorded as a deliberate omission.
