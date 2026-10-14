---
priority: P3
adopters: BOTH
summary: >-
  RESOLVED (2026-10-13) — the date-time field follows the locale's 12- or 24-hour clock and reads a date-only value as local midnight; Tooltips open on focus theme-wide; "Outline" is icon-only under a 280px header; `fields/toolbar-wrap.ts` hides a separator at a row's edge
---
# Form header and date picker: follow-ups

## Status: RESOLVED 2026-10-13

## Priority: P3 [BOTH]

From the reviews of the form header and date picker PR (`editor/FormHeader.tsx`,
`editor/fields/DateTimeField.tsx`). The rules are in
[docs/ux-guidelines.md](../../../docs/ux-guidelines.md#fields).

## Date picker

- **12 or 24 hours, and the time zone.** The field shows `D MMM YYYY, HH:mm:ss`, but the
  dropdown's native time input follows the browser locale, so en-US shows "08:30:00 AM". Take
  both from the locale (dayjs `localizedFormat`, or `timeInputProps`), and show the time zone.
- **Date-only values.** A stored `2024-05-01` parses as UTC midnight, so it shows as the previous
  evening west of UTC. Read a date-only string as local midnight.

Placeholder contrast belongs to [contrast-beyond-the-ruled-colours.md](contrast-beyond-the-ruled-colours.md).

## Tooltips on focus

[Accessibility](../../../docs/ux-guidelines.md#accessibility) has every icon-only control's Tooltip
open on focus as well as hover. Mantine's default is hover only, and most editor Tooltips pass no
`events`; set the default once in `theme.tsx`'s `components`.

## Form header and toolbar

- **Narrow pane.** Below about 200px of pane the "Outline" button and chevrons clip. Make
  "Outline" icon-only under a container width (a container query on the form pane).
- **Toolbar separators.** A wrapped markdown toolbar can end a row with a separator. Hide a
  separator that ends its row, or group the toolbar into wrap units.
