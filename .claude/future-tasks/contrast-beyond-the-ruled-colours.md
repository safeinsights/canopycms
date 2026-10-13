---
priority: P3
adopters: BOTH
summary: >-
  What is left of docs/ux-guidelines.md "Colour and contrast" after the theme pass: filled badges in colours other than the primary (blue, green, grape in the permission editor and member list) put white text on a fill under 4.5:1, and Checkbox, Radio and Switch borders are still Mantine's gray.4, under 3:1
---
# Contrast beyond the ruled colours

The theme (`packages/canopycms/src/editor/theme.tsx`) now draws every colour's text, light and
subtle variants and outline at 4.5:1, fills the primary at shade 7 (light) and 8 (dark), and sets
the dimmed, placeholder, danger-text, input-border, surface and count-badge tokens, with the ratios
pinned in `theme.test.tsx`. Two gaps remain.

## Filled badges in other colours

`variant="filled"` puts white text on the colour's `primaryShade` step: blue.7 is 4.20:1, green.7
2.75:1. Used by `permission-manager/PermissionLevelBadge.tsx` and `PermissionEditor.tsx` (colours
from `LEVEL_CONFIG` in `permission-manager/constants.tsx`: blue, green, grape) and
`group-manager/MemberList.tsx` (blue). Either make them light badges, which the theme already
makes readable, or give filled badges Mantine's `autoContrast` (black text on light fills) without
breaking the filled red and orange Button resolver in `theme.tsx`.

## Checkbox, Radio and Switch borders

Mantine draws their unchecked borders at `gray.4` (1.49:1 on white) and `dark.4` from class rules,
not variables, so no theme variable reaches them; the `Input.extend` approach in `theme.tsx` covers
text inputs only. Needs a scoped CSS rule or per-component `styles`, measured against 3:1 like
`--canopy-input-border`.

## Done when

Every filled badge's text and every control border measures at the guideline's ratio in both
schemes, pinned in `theme.test.tsx`.
