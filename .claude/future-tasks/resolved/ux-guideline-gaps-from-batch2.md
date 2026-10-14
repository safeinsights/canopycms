---
priority: P3
adopters: BOTH
summary: >-
  RESOLVED (2026-10-14, UX batch 3 theme PR) — `editor/theme.tsx`'s Badge extension sets `textTransform: 'none'` theme-wide, UserBadge's local override is gone, and badge strings that relied on uppercase are written in sentence case
---

# UX batch 2 gaps: Badge case

The rule is in [docs/ux-guidelines.md](../../../docs/ux-guidelines.md#copy) (sentence case for
every badge).

- **Badge case.** Turn off `Badge`'s uppercase in `editor/theme.tsx`, then drop `UserBadge`'s
  local `textTransform: 'none'`.
