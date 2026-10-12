---
priority: P3
adopters: BOTH
summary: >-
  Code only: docs/ux-guidelines.md now places one entry's lasting state above its form and the unsaved indicator in the top bar, icon-only below `lg` (provisional until the shell redesign settles). EditorHeader still shows the indicator's full text at every width.
---
# Unsaved indicator: icon-only below `lg`

[docs/ux-guidelines.md](../../docs/ux-guidelines.md#shell-regions) has the rule. The header's
"Unsaved · kept on this device" indicator (`packages/canopycms/src/editor/components/EditorHeader.tsx`)
shows its full text at every width. Below `lg`, show an icon whose accessible name and Tooltip
carry the text. The rule is provisional, so do this with or after the shell redesign.
