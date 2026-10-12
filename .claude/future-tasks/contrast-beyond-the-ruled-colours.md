---
priority: P2
adopters: BOTH
summary: >-
  New 2026-10-11, from PR 532's UX review. The guideline rules only dimmed text, count badges, filled red and filled orange. Measured on the same surfaces, many other editor controls fall under 4.5:1 text contrast: light orange and red buttons, red menu items, light brand Save and Open, filled brand "Submit for review", the Comments count indicator and the "In review" badge. Dark mode also trades dimmed against body text
---
# Contrast beyond the ruled colours

[docs/ux-guidelines.md](../../docs/ux-guidelines.md#colour-and-contrast) sets text contrast at 4.5:1 (3:1
for large text) but rules only four colours. Measured on the surfaces PR 532 touched:

| Control                                                | Contrast (light) | Dark  |
| ------------------------------------------------------ | ---------------- | ----- |
| Light orange buttons                                   | 2.34:1           |       |
| Light red "Purge", "Delete branch"                     | 2.92:1           |       |
| Red menu items                                         | 3.28:1           | 4.13  |
| Light brand "Save", "Open"                             | 3.82:1           |       |
| Filled brand "Submit for review", Comments count badge | 4.32:1           | 3.67  |
| "In review" badge                                      | 2.17:1           |       |

Suggested:

- light-variant `--button-color` at shade 8-9 in the `Button.extend` `vars` in `theme.tsx`;
- red menu items `red.8`;
- filled brand one shade darker (or `primaryShade` 7 in light mode);
- the Comments count indicator as tinted text on a tinted background, the guideline's count-badge form;
- the "In review" badge from `branch-status.ts`.

Then add each rule to the guideline's Colour section and a measured test to `theme.test.tsx`.

Dark mode also trades off: dimmed is now `dark.1` (#b8b8b8), close to body text (#c9c9c9), so
dimmed no longer reads as secondary there. Pick a step that is both at least 4.5:1 and visibly
quieter, or accept the trade-off in the guideline.
