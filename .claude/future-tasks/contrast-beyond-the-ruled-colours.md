---
priority: P3
adopters: BOTH
summary: >-
  What is left of docs/ux-guidelines.md "Colour and contrast" after the theme pass: filled colours other than the primary, which JP ruled 2026-10-13 must become light variants; in dark mode a combobox's armed option and the date picker's selected day put white on primary shade 5 (3.67:1); and Checkbox, Radio and Switch borders, ruled to take `--canopy-input-border`, are still Mantine's gray.4, under 3:1
---
# Contrast beyond the ruled colours

The theme (`packages/canopycms/src/editor/theme.tsx`) now draws every colour's text, light and
subtle variants and outline at 4.5:1, fills primary Buttons and Badges with `--canopy-primary-fill`,
and sets the dimmed, placeholder, danger-text, input-border, surface and count-badge tokens, with
the ratios pinned in `theme.test.tsx`. Three gaps remain.

## Filled colours other than the primary

`variant="filled"` puts white text or icons on the colour's `primaryShade` step: shade 7 in light
(blue 4.20:1, green 2.75:1) and shade 5 in dark (green 2.01, blue 2.99, grape 3.33, gray 2.07,
red 2.78, orange 2.23), as on the base. Surfaces: `permission-manager/PermissionLevelBadge.tsx` and
`PermissionEditor.tsx` (colours from `LEVEL_CONFIG` in `permission-manager/constants.tsx`),
`group-manager/MemberList.tsx` and filled `UserBadge`, `schema-editor/CollectionEditor.tsx`'s
"Default" and "Singleton" badges, `media/AssetCard.tsx`'s red "Remove from library" ActionIcon
(an icon, 3:1), and `components/EditorSidebar.tsx`'s orange Indicator. The guideline now says a
colour other than the primary is never filled: make each of these a light variant, which the
theme already makes readable, leaving the filled red and orange Button resolver in `theme.tsx`
alone. Mantine's `Indicator` has no `variant`, so the sidebar's takes text colour on an opaque tint
through `styles` or `--indicator-color`, an orange counterpart of `--canopy-count-bg` (the
`-light` variable is translucent). It shows while the ActionIcon beneath it is filled, so measure
its count against both that fill and the rail.

## White on the primary colour in dark mode

Primary Buttons and Badges fill with `--canopy-primary-fill` (4.98:1 under white), but other
places Mantine puts white text on `--mantine-primary-color-filled` (shade 5 in dark, 3.67:1)
still miss 4.5:1: a combobox's armed option (Select, Tags, the quick-open palette, whose slug
also has `opacity: 0.75`, 3.53:1 even in light mode), the date picker's selected day and focused
time segment. Shade 5 stays because focus rings, focused borders and checked controls need 3:1
on dark surfaces. Each needs the fill token through a scoped rule or the component's `styles`.
Shade 5 measures 3:1 for the default brand only: darker adopter brands (`#1e3a8a` 2.21:1 on
dark.5) fall short, as on the base. Focus rings get their own token in
[object-clear-undo-and-ux-batch2-review-leftovers.md](object-clear-undo-and-ux-batch2-review-leftovers.md);
focused input borders and checked Checkbox, Radio and Switch fills still draw in shade 5, and a
measured indicator token would need routing through every focus and checked-state selector
Mantine draws.

## Checkbox, Radio and Switch borders

Mantine draws their unchecked borders at `gray.4` (1.49:1 on white) and `dark.4` from class rules,
not variables, so no theme variable reaches them; the `Input.extend` approach in `theme.tsx` covers
text inputs only. Give their borders and tracks `--canopy-input-border` through a scoped CSS rule
or per-component `styles`; [switch-track-contrast.md](switch-track-contrast.md) is the Switch
case.

## Done when

Every filled badge's text and every control border measures at the guideline's ratio in both
schemes, pinned in `theme.test.tsx`.
