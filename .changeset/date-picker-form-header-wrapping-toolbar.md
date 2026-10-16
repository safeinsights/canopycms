---
'canopycms': minor
---

### A date picker, a form header, and a toolbar that wraps

<!-- migration
area: Editing
action: Editor UI tests
row: Date picker, form header, wrapping toolbar
-->

**What changed.** A `datetime` field is a Mantine `DateTimePicker`, still stored as ISO UTC. The
form has a sticky header with the entry's title and type, an "Outline" of its fields and rows to
jump to, and Expand or Collapse all lists. The markdown toolbar wraps in a narrow form. canopycms
now depends on `@mantine/dates` and `dayjs`, and loads `@mantine/dates/styles.css` with its other
editor styles.

**To adopt.** Nothing. Browser tests that typed into a `datetime-local` input pick a date instead.
