---
priority: P3
adopters: BOTH
summary: >-
  What is left of docs/ux-guidelines.md "Colour and contrast" after the theme pass: filled colours other than the primary put white text on a fill under 4.5:1 (shade 5 in dark); in dark mode a combobox's armed option and the date picker's selected day put white on primary shade 5 (3.67:1); and Checkbox, Radio and Switch borders are still Mantine's gray.4, under 3:1
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
(an icon, 3:1), and `components/EditorSidebar.tsx`'s orange Indicator. The guideline rules only
filled red, orange and primary; a rule for other filled colours is needed too ("light variant, or
a measured fill", as `--canopy-primary-fill` does for the primary). Either make them light badges, which the theme already
makes readable, or give filled badges Mantine's `autoContrast` (black text on light fills) without
breaking the filled red and orange Button resolver in `theme.tsx`.

## White on the primary colour in dark mode

Primary Buttons and Badges fill with `--canopy-primary-fill` (4.98:1 under white), but other
places Mantine puts white text on `--mantine-primary-color-filled` (shade 5 in dark, 3.67:1)
still miss 4.5:1: a combobox's armed option (Select, Tags, the quick-open palette, whose slug
also has `opacity: 0.75`, 3.53:1 even in light mode), the date picker's selected day and focused
time segment. Shade 5 stays because focus rings, focused borders and checked controls need 3:1
on dark surfaces. Each needs the fill token through a scoped rule or the component's `styles`.
Shade 5 measures 3:1 for the default brand only: darker adopter brands (`#1e3a8a` 2.21:1 on
dark.5) fall short, as on the base; a measured indicator token would need routing through every
focus and checked-state selector Mantine draws.

## Dark light-variant hue

Dark light and subtle variants are measured on their hover tint over dark.4 (a hovered menu item),
the strictest case, which pushes brand to brand.1, close to neutral: "Editing" beside "Archived"
reads nearly the same. Measuring on dark.6 keeps brand.2 but drops to 4.1-4.4:1 on dark.4.

## Checkbox, Radio and Switch borders

Mantine draws their unchecked borders at `gray.4` (1.49:1 on white) and `dark.4` from class rules,
not variables, so no theme variable reaches them; the `Input.extend` approach in `theme.tsx` covers
text inputs only. Needs a scoped CSS rule or per-component `styles`, measured against 3:1 like
`--canopy-input-border`.

## Done when

Every filled badge's text and every control border measures at the guideline's ratio in both
schemes, pinned in `theme.test.tsx`.
