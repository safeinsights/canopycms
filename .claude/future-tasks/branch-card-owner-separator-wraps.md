---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-13, from PR 548's UX review. On a branch card with an action button the meta line wraps, and the "•" separator grouped with the owner block leads the wrapped line ("• Owner: …")
---

# Branch card owner line wraps with a leading bullet

`BranchManager.tsx`'s card meta line renders "Updated 2h ago", then a group holding "•" and
"Owner: <name>". On a card with an action button the line is narrow enough to wrap, and the
separator travels with the owner group, so the second line starts with "•".

## Fix

Attach the separator to the item before it, or render it only when both items share a line (a
CSS `gap` with a pseudo-element separator, or no separator and a wider gap).
