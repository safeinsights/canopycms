---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-10, from the editor UI epic's WS3. The yellow lock banners' buttons ("Create a branch", "Manage Branches") and the read-only draft notice's "Discard changes" use Mantine `variant="light" color="yellow"`, whose pale yellow text on a yellow-tinted alert looks below the 4.5:1 contrast docs/ux-guidelines.md asks for; measure and switch to a darker colour or variant
---
# Yellow banner buttons may miss text contrast

`components/EditorHeader.tsx` (protected-branch and status-locked banners) and
`components/ReadOnlyDraftNotice.tsx` render their action as
`<Button variant="light" color="yellow">` inside a `color="yellow" variant="light"` Alert.
In Storybook the button text reads as pale yellow on pale yellow.

## Fix

Measure the computed text and background colours (axe via Playwright, or devtools). If below
4.5:1, use one darker treatment for all three, such as `color="yellow.9"` text or
`variant="default"`, and check `pnpm lint:a11y` and the `ux-review` agent agree.
