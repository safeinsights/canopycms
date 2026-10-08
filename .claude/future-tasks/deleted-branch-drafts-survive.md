# A deleted branch's unsaved drafts come back on a new branch with the same name

## Priority: P3

Found 2026-10-07, while making delete switch the editor off the deleted branch.

## Problem

`useDraftManager` persists drafts in `localStorage` under `canopycms:drafts:<branchName>`.
Deleting a branch never removes that key. If anyone in that browser later creates a branch
with the same name, opening it restores the old branch's drafts against the new branch's
content.

The delete confirmation (`useBranchManager.tsx`'s `showDeleteConfirmation`) says it will
"Discard any unsaved or unmerged changes", so the dialog promises what the browser does not
do.

## Fix sketch

On a successful delete, clear the deleted branch's draft key. Care is needed if the deleted
branch is the open one: `useDraftManager`'s persist effect writes the in-memory drafts back
under the key they were loaded for, so the removal has to happen after the editor has switched
branches, or through `useDraftManager` itself. Other tabs still holding the branch open can
also write the key back.
