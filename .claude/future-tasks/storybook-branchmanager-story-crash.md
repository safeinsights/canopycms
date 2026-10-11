---
priority: P3
adopters: NEITHER
summary: >-
  New 2026-10-10. The `Editor/BranchManager` Default story throws "Unknown operating mode: undefined" from `clientOperatingStrategy`, because the story passes no operating mode. It is also Storybook's landing story, so every Storybook session opens on an error
---
# BranchManager story crashes in Storybook

Opening Storybook (`pnpm --dir packages/canopycms storybook`) lands on `Editor/BranchManager` →
Default. That story throws:

```
Error: Unknown operating mode: undefined
    at clientOperatingStrategy (src/operating-mode/client-safe-strategy.ts)
    at BranchManager (src/editor/BranchManager.tsx)
```

`BranchManager` takes a required `mode` prop and resolves its client operating strategy from it, and the stories never pass one. Give
the stories a mode (`dev` is enough), and check the other `BranchManager` stories for the same
gap.
