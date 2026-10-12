---
priority: P3
adopters: NEITHER
summary: >-
  The whole-Editor Storybook stories (`Editor/Editor`, `Editor/CanopyEditor`) crash with "process is not defined" from `src/utils/debug.ts`, so no story renders the full editor: header menus, the rail Settings menu and their overlays can't be walked in Storybook.
---

# Whole-Editor stories crash in Storybook

Found by the PR 538 UX review. Opening `Editor/Editor` or `Editor/CanopyEditor` throws
`ReferenceError: process is not defined` at `packages/canopycms/src/utils/debug.ts`, which reads
`process.env` at module or call time. Storybook's Vite build defines no `process` global.
[storybook-branchmanager-story-crash.md](storybook-branchmanager-story-crash.md) is a
different crash in another story.

## Options

- Guard the read (`typeof process !== 'undefined'`) in `debug.ts`.
- Define `process.env` in the Storybook Vite config (`define`).

## Done when

Both stories render, and header and rail menus can be walked there.
