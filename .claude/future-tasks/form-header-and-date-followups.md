---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-12. Follow-ups from the form header and date picker PR: the picker's time input
  follows the browser's 12/24-hour clock while the field shows 24-hour, date-only values show the
  previous evening west of UTC, placeholders are 2.1:1, toolbar separators dangle at a wrap, the
  header's "Outline" text clips in a very narrow pane, and five UX guideline gaps
---
# Form header and date picker: follow-ups

## Priority: P3 [BOTH]

Found 2026-10-12 by the reviews of the form header and date picker PR
(`editor/FormHeader.tsx`, `editor/fields/DateTimeField.tsx`).

## Date picker

- **12 or 24 hours.** The field shows `D MMM YYYY, HH:mm:ss`, but the dropdown's native time input
  follows the browser locale, so en-US shows "08:30:00 AM". Choose the format from the locale
  (dayjs `localizedFormat`), or pass `timeInputProps` that force one clock.
- **Date-only values.** A stored `2024-05-01` parses as UTC midnight, so it shows as the previous
  evening west of UTC. The old `datetime-local` input did the same. A `date`-only field type, or
  reading a date-only string as local midnight, would fix it.
- **Placeholder contrast.** "Pick a date and time" is Mantine's placeholder colour, 2.1:1 on
  white, as on every other input. Raise it in `theme.tsx` for all inputs.

## Form header and toolbar

- **Narrow pane.** Below about 200px of pane the "Outline" button and chevrons clip. Make
  "Outline" icon-only under a container width (a container query on the form pane).
- **Toolbar separators.** A wrapped markdown toolbar can end a row with a separator. Hide a
  separator that ends its row, or group the toolbar into wrap units.

## Guideline gaps for `docs/ux-guidelines.md`

- Non-text contrast (icons, control borders, 3:1) is unstated.
- Whether every icon-only control's Tooltip opens on focus, not only a disabled one's.
- Date inputs: format, 12/24 hours and the time zone shown.
- Sticky regions reserve scroll padding so focus is never hidden (WCAG 2.4.11), as `FormHeader`
  does.
- What to show for an unlabelled schema name (humanise, as `entryTypeLabel` does, or hide), and
  whether resetting one field's value is "Remove", given an object field's existing "Clear".
