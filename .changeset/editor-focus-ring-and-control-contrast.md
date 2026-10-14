---
'canopycms': minor
---

### Editor focus rings and checked controls reach 3:1 for any brand

<!-- migration
area: Editing
action: Visual snapshot tests
row: Focus ring, control borders, light badges, sentence-case badges
-->

**What changed.** Focus rings, focused borders and checked controls draw in `--canopy-focus-ring`,
the first step of your primary colour at 3:1 on the editor's surfaces, so a dark brand such as
`#1e3a8a` is lightened in dark mode and a checked control's tick turns black where white would
not show. Unchecked Checkbox, Radio and Switch borders take `--canopy-input-border`. Selected
options and dates sit on `--canopy-primary-fill`. Badges are sentence case, coloured badges and
indicators use their light variant, dark-mode dimmed text is italic, and Markdown popups have a
border in dark mode.

**To adopt.** Nothing, unless visual snapshots or browser tests assert the old colours or
uppercase badge text. A `themeOverride` that sets `primaryShade` moves where the ring starts.
