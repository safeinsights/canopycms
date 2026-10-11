---
priority: P2
adopters: BOTH
summary: >-
  New 2026-10-10, from the editor UI epic's WS3. The yellow lock banners' buttons ("Create a branch", "Manage Branches") use Mantine `variant="light" color="yellow"`: rgb(250,176,5) text on a yellow-tinted alert, about 1.7:1 against the 4.5:1 docs/ux-guidelines.md asks for. Switch to `variant="default"`, as ReadOnlyDraftNotice does
---
# Yellow banner buttons miss text contrast

`components/EditorHeader.tsx` (protected-branch and status-locked banners) renders each banner's
action as `<Button variant="light" color="yellow">` inside a `color="yellow" variant="light"`
Alert. The editor UX review measured the same style at about 1.7:1 on the read-only draft
notice, which now uses `variant="default"`.

## Fix

Use `variant="default"` for both banner buttons, matching `ReadOnlyDraftNotice`, and confirm
the computed contrast reaches 4.5:1.
