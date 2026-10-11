---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-10, from the editor UI epic's WS3 UX review. docs/ux-guidelines.md is silent on a lasting state scoped to one entry (the read-only draft notice sits in the form, not the banner region) and on the unsaved/saved indicator (where it goes, how it relates to "Saved")
---
# UX guideline gaps: entry-scoped states and the save indicator

Two patterns WS3 introduced have no rule in `docs/ux-guidelines.md`:

1. **Entry-scoped lasting state.** "Choosing a surface" sends lasting states to the banner
   region, but `ReadOnlyDraftNotice` describes one entry and sits above its form.
2. **Save state.** The header's "Unsaved · kept on this device" indicator
   (`components/EditorHeader.tsx`) has no rule for placement, narrow widths (an icon below
   `lg` was suggested), or how it relates to "a saved entry shows 'Saved' inline".

## Fix

Add a line for each to the guidelines once the shell redesign (WS1) settles where the indicator
lives. The doc is at its word budget, so trim as much as is added.
