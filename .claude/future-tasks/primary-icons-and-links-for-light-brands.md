---
priority: P3
adopters: BOTH
summary: >-
  Found in the UX batch 3 theme PR: a filled primary ActionIcon (the sidebar's "Toggle highlights") puts white on the brand's primary shade, under 3:1 for a light brand such as #facc15 (1.51:1 in dark mode), and links take `--mantine-primary-color-filled`, now the 3:1 focus ring, so a light brand's link text misses 4.5:1; Mantine surfaces an adopter's custom field might use put white on that ring too
---

# Primary icons and links for light brands

Each passes for the default brand and fails for some adopter brand.

- **Filled primary ActionIcon.** `components/EditorSidebar.tsx`'s "Toggle highlights" is
  `variant="filled" color="brand"`, which Mantine draws on `--mantine-color-brand-filled` (the
  primary shade) under a white icon. Route a filled primary ActionIcon to `--canopy-primary-fill`
  as `theme.tsx` does for Button, then re-measure the fill against the sidebar rail: the pressed
  state is shown by that fill, and the primary fill is 2.73:1 on dark.6.
- **Link text.** Mantine's light-mode `--mantine-color-anchor` is
  `var(--mantine-primary-color-filled)`, which the theme makes `--canopy-focus-ring`, measured
  at 3:1 rather than text's 4.5:1 (#facc15's ring is 3.36:1 on white). Give the anchor colour a
  4.5:1 step, such as the brand's `-text` variable, and pin it in `theme.test.tsx`.
- **White on the ring outside the editor's own calls.** Mantine surfaces that fall back to
  `--mantine-primary-color-filled` under white text or icons now sit on the ring, which dark mode
  lightens for a dark brand (`#1e3a8a`: white 2.75:1, against 5.06:1 on shade 5): a default
  Indicator, an ActionIcon or ThemeIcon with neither `variant` nor `color`, a checked Chip,
  Pagination, Stepper, a Notification's icon, a Switch's `onLabel`. No editor call site reaches
  one today; an adopter's custom field could.
