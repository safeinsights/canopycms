---
priority: P3
adopters: BOTH
summary: >-
  Code follow-ups from the form header and date picker PR: the date-time field must take its 12/24-hour clock from the locale and show the time zone, date-only values must read as local midnight, icon-only tooltips must open on focus, toolbar separators dangle at a wrap, and the header's "Outline" text clips in a very narrow pane
---
# Form header and date picker: follow-ups

## Priority: P3 [BOTH]

From the reviews of the form header and date picker PR (`editor/FormHeader.tsx`,
`editor/fields/DateTimeField.tsx`). The rules are in
[docs/ux-guidelines.md](../../docs/ux-guidelines.md#fields).

## Date picker

- **12 or 24 hours, and the time zone.** The field shows `D MMM YYYY, HH:mm:ss`, but the
  dropdown's native time input follows the browser locale, so en-US shows "08:30:00 AM". Take
  both from the locale (dayjs `localizedFormat`, or `timeInputProps`), and show the time zone.
- **Date-only values.** A stored `2024-05-01` parses as UTC midnight, so it shows as the previous
  evening west of UTC. Read a date-only string as local midnight.

Placeholder contrast belongs to [contrast-beyond-the-ruled-colours.md](contrast-beyond-the-ruled-colours.md).

## Tooltips on focus

[Accessibility](../../docs/ux-guidelines.md#accessibility) has every icon-only control's Tooltip
open on focus as well as hover. Mantine's default is hover only, and most editor Tooltips pass no
`events`; set the default once in `theme.tsx`'s `components`.

## Form header and toolbar

- **Narrow pane.** Below about 200px of pane the "Outline" button and chevrons clip. Make
  "Outline" icon-only under a container width (a container query on the form pane).
- **Toolbar separators.** A wrapped markdown toolbar can end a row with a separator. Hide a
  separator that ends its row, or group the toolbar into wrap units.
