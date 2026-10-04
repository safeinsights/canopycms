# [P3] knip: ten exports with no importer, tagged instead of deleted

**Status:** Open. Filed 2026-09-14 from the manager's review of the Chip B encapsulation PR in
[baseline-quality-202609.md](resolved/baseline-quality-202609.md).

`pnpm lint:exports` (knip, production mode, `--tags=-internal`) reported these exports with no
importer anywhere, tests included. The chip's rule was "do not delete code", and removing
`export` alone would trip eslint's `no-unused-vars`, so each carries
`@internal No importer; deletion candidate in knip-no-importer-deletion-candidates.md.`, which
hides it from knip. Nothing else holds the decision. Per symbol: delete it, or wire it up and
drop the tag.

## Candidates by file

- `packages/canopycms/src/api/branch-merge.ts` — `MarkAsMergedParams`
- `packages/canopycms/src/api/entries.ts` — `EntryTypeSummary`, `ListEntriesParams`
- `packages/canopycms/src/api/permissions.ts` — `SearchUsersParams`, `GetUserMetadataParams`
- `packages/canopycms/src/content-index-generation.ts` — `contentIndexGenerationPath`
- `packages/canopycms/src/operating-mode/types.ts` — `ResolveRemoteUrlOptions`
- `packages/canopycms/src/resolve-canopy-user.ts` — `resetResolveCanopyUserWarningForTests`
- `packages/canopycms/src/schema/resolver.ts` — `hasSchemaFiles`
- `packages/canopycms/src/utils/debug.ts` — `testLogger`

`EditorStateProvider`, `useEditorLoading`, `useEditorModals` and `useEditorPreview` in
`packages/canopycms/src/editor/context/EditorStateContext.tsx` carry the same tag pointing at
[editor-state-context-migration.md](editor-state-context-migration.md), which owns them.
