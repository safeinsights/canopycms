# [P3] `useBranchManager`'s `operatingMode` option is unused

`packages/canopycms/src/editor/hooks/useBranchManager.tsx` declares `operatingMode: OperatingMode`
on `UseBranchManagerOptions` (line 172), and `Editor.tsx` passes it (line 246), but the hook body
never reads it. The only client-side effect of the operating mode is the scaffolded edit page's
auth selection plus the `supportsStatusBadge` / `supportsComments` checks in `EditorHeader.tsx`, so
an option that looks as if it feeds the mode into branch management is one more thing an audit of
the mode has to rule out.

## Fix

Remove the option from `UseBranchManagerOptions` and from the call site in `Editor.tsx`, then run
the typecheck.
