# An unsaved draft disappears from view when its entry's path is deleted and recreated

Found 2026-10-04 while re-verifying
[occ-version-key-contentid-swap.md](resolved/occ-version-key-contentid-swap.md).

## The problem

`useDraftManager` keys drafts by contentId. When another editor deletes and recreates
the path an editor has open, the next entries refresh gives that path a new contentId.
The open form then shows the recreated entry, and the editor's own unsaved draft, still
filed under the old contentId, has no entry left to show it:

- `editedFiles` drops it, because it looks drafts up in `entries` by contentId.
- `modifiedCount` still counts it, so the badge reports an edit nobody can open.
- It stays in `canopycms:drafts:<branch>` in localStorage until "Discard all".

Nothing is overwritten on the server: with no entry to open, the draft cannot be saved. But the
editor's work disappears with no message, and the count disagrees with what is on screen.

## Fix direction

When a draft's contentId stops appearing in `entries` but its path still does, tell the
editor. Offer to copy the draft into the new entry, or to export or discard it. Don't
merge it silently: the recreated entry may be unrelated content.
