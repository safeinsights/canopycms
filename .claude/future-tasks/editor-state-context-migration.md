# EditorStateContext Migration

Complete the migration from Editor.tsx inline state to the existing EditorStateContext.

## Problem

Editor.tsx is 1,221 lines with ~30 `useState` calls for loading, modal, and preview state. An `EditorStateContext` already exists at `src/editor/context/EditorStateContext.tsx` that manages exactly this state (loading, modals, preview) via typed actions — but Editor.tsx doesn't use it.

## What to do

1. Wire `EditorStateProvider` into the editor component tree (likely in `CanopyEditor.tsx` or `CanopyEditorPage.tsx`)
2. Replace the inline `useState` calls in Editor.tsx for loading states (`branchesLoading`, `entriesLoading`, `commentsLoading`), modal states (`groupManagerOpen`, `permissionManagerOpen`, `branchManagerOpen`), and preview state (`previewData`, `previewLoadingState`) with `useEditorModals()`, `useEditorLoading()`, `useEditorPreview()` hooks
3. Editor.tsx has additional state beyond what EditorStateContext covers (schema editor, rename modal, delete confirmation) — either extend EditorStateContext or leave those as local state
4. Consider splitting Editor.tsx into sub-components (EditorShell, EditorContent, EditorModals) as part of this migration

## Also fold in: `entriesLoading` has two independent writers (2026-07-30, PR #183 review)

`entriesLoading` is written both by useEntryManager's SWR `isValidating`
mirror effect AND by Editor.tsx's per-entry content-load effect (via the
shared `setBusy`). A revalidation completing mid-entry-load can clear the
busy flag under a still-running load, and the stale-settle clear arm
(`loadingEntryIdsRef.size === 0`) slightly widens the reverse window. Purely
cosmetic spinner raciness — but it has now been patched twice ad hoc; the
real fix is two separate flags OR'd at render, which this migration is the
natural home for.

## Files

- `src/editor/Editor.tsx` — main component, lines 142-176 have the duplicate state
- `src/editor/context/EditorStateContext.tsx` — existing context with providers and hooks
- `src/editor/CanopyEditor.tsx` or `CanopyEditorPage.tsx` — where to add the provider
