---
'canopycms': minor
---

### Editor colours reach 4.5:1 in light and dark mode

<!-- migration
area: Editing
action: Visual snapshot tests
row: Editor colours reach contrast in both schemes
-->

**What changed.** The editor theme draws each colour's text, light and subtle variants at 4.5:1,
fills the primary colour one shade darker (7 in light mode, 8 in dark), and sets placeholders,
dark-mode dimmed text, input borders (3:1), destructive and error text, and editor panels from
scheme-aware variables, so `colorScheme="dark"` leaves no light surface behind. Every Tooltip
opens on keyboard focus. Date-time fields follow the browser's 12- or 24-hour clock and read a
date-only value as local midnight; empty header menus show a focusable item saying why.

**To adopt.** Nothing, unless visual snapshots or browser tests assert the old colours, or click
the navigator's "Delete…" or "Delete collection…", now "Delete entry" and "Delete collection". A
`themeOverride` setting `primaryShade` or `components.Tooltip.defaultProps.events` replaces these
defaults.

**Now deletable.** Local overrides that darkened light buttons, badges, placeholders or input
borders for contrast.
