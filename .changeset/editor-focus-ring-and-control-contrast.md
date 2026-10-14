---
'canopycms': minor
---

### Editor focus rings and checked controls reach 3:1 for any brand

<!-- migration
area: Editing
action: Visual snapshot tests
row: Focus ring, control borders, light badges, sentence-case badges
-->

**What changed.** Focus rings, focused borders, checked controls and the active tab draw in
`--canopy-focus-ring`, the first step of your primary colour at 3:1 on the editor's surfaces, so
a dark brand such as `#1e3a8a` is lightened in dark mode and a checked control's tick turns black
where white would not show. Unchecked Checkbox, Radio and Switch borders take
`--canopy-input-border`. Selected options and dates sit on `--canopy-primary-fill`. Badges are
sentence case, coloured badges use their light variant, dark-mode dimmed text and input
descriptions are italic, the navigator's entry badge shows the entry type's label, and Markdown
popups have a border in dark mode.

**To adopt.** Nothing, unless visual snapshots or browser tests assert the old colours or badge
text, such as the System Health panel's "corrupt metadata", now "Corrupt metadata". A
`themeOverride` that sets `primaryShade` moves where the ring starts.
