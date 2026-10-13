---
priority: P2
adopters: BOTH
summary: >-
  Code items for the contrast rules in docs/ux-guidelines.md "Colour and contrast": light orange and red buttons, light brand Save and Open, filled brand "Submit for review", the Comments count indicator and the "In review" badge all fall under 4.5:1; the dark-mode dimmed token, placeholder colour and 3:1 icon and border contrast are not yet set in the theme
---
# Contrast beyond the ruled colours

[docs/ux-guidelines.md](../../docs/ux-guidelines.md#colour-and-contrast) now rules every
control and status badge to 4.5:1 for text, icons and control borders to 3:1, and names the
theme tokens. The code does not meet it yet.

## Controls under 4.5:1 (measured on the surfaces PR 532 touched)

| Control                                                | Contrast (light) | Dark  |
| ------------------------------------------------------ | ---------------- | ----- |
| Light orange buttons                                   | 2.34:1           |       |
| Light red "Purge", "Delete branch"                     | 2.92:1           |       |
| Light brand "Save", "Open"                             | 3.82:1           |       |
| Filled brand "Submit for review", Comments count badge | 4.32:1           | 3.67  |
| "In review" badge                                      | 2.17:1           |       |

Suggested:

- light-variant `--button-color` at shade 8-9 in the `Button.extend` `vars` in `theme.tsx`;
- filled brand one shade darker (or `primaryShade` 7 in light mode);
- the Comments count indicator as text colour on a tinted background, the guideline's count-badge form;
- the "In review" badge from `branch-status.ts`.

Red menu items belong to [destructive-menu-item-contrast.md](destructive-menu-item-contrast.md).

## Theme tokens

- **Dark dimmed.** `canopyCssVariablesResolver` sets dark `--mantine-color-dimmed` to `dark.1`,
  1.2:1 under body text. Set it to the guideline's 85/15 `color-mix` of `dark.1` and `dark.2`
  (`#b0b0b0`: 4.6:1 on `dark.4`, the menu hover, and 1.3:1 under body text), and update the
  measurements in its comment. A blocked `ReasonedMenuItem`'s reason sits on `dark.4` when
  arrowed to.
- **Placeholders.** Mantine's placeholder colour is 2.1:1 on white (gray.5) and dark.3 in dark
  mode. Set `--mantine-color-placeholder` in the resolver to a step reaching 4.5:1 on every
  input background in both schemes (`gray.6` is 3.3:1 on white, so light needs `gray.7`).
- **Non-text 3:1.** Mantine's default input border (gray.4, about 1.5:1 on white) and
  subtle-variant icons need measuring against 3:1 and raising in the theme.

## Done when

Each control above measures at least 4.5:1, each token is set, and `theme.test.tsx` pins the
measured ratios.
