# [P3] `useBranchManager`'s `operatingMode` option is unused, and two JSDoc examples use a mode that doesn't exist

Filed 2026-09-12 while tracing what the browser does with its operating mode, for PR 6 of
[cms-image-build-epic.md](cms-image-build-epic.md). Not fixed there: it's editor code, and that PR
is docs.

## What

- `packages/canopycms/src/editor/hooks/useBranchManager.tsx:190` declares
  `operatingMode: OperatingMode` on `UseBranchManagerOptions`, and `Editor.tsx:253-255` passes it,
  but the hook body never reads it.
- The JSDoc examples at `useBranchManager.tsx:238` and `components/EditorHeader.tsx:214` pass
  `operatingMode: 'collaboration'` and `operatingMode="collaboration"`. There is no such mode:
  `clientOperatingStrategy()`'s exhaustive switch (`operating-mode/client-safe-strategy.ts`)
  accepts only `prod` and `dev`.

## Why it matters, a little

PR 6 had to establish that the only client-side effect of the mode is the scaffolded edit page's
auth selection. An option that looks as if it feeds the mode into branch management, but does
nothing, is one more thing such an audit has to rule out. The examples would fail type-checking if
copied.

## Fix

Remove the option from `UseBranchManagerOptions` and from the call site in `Editor.tsx` (or say in
its doc comment why it stays), and change both examples to a real mode. Run the typecheck.
