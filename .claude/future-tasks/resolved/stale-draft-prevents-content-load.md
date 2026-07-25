# Stale localStorage Draft Prevents Content Load

A stale draft in localStorage can permanently prevent the editor from loading fresh content from the API, leaving the Body field (and potentially other fields) empty with no indication to the user.

## Problem

The load effect in `Editor.tsx` (~line 345) skips the API call if a draft already exists:

```js
if (!currentEntry || !contentId || drafts[contentId]) return
```

Drafts are restored from localStorage on mount (`useDraftManager`). If a draft was saved with incomplete data (e.g., during initial setup, a failed first load, or before content migration was complete), every subsequent editor visit restores that stale draft instead of fetching fresh content. The user sees the form with empty fields and no error — the preview iframe shows the correct content (loaded server-side), but the form shows stale draft data.

## Discovered in

docs-site-proto integration. After migrating content to Canopy's ID-based naming, opening the editor showed the preview correctly but the Body field was empty. Clearing `canopycms:drafts:<branch>` from localStorage fixed it.

## Possible fixes

1. **Staleness detection**: Compare draft timestamp against the file's `updatedAt` from the entries API. If the file is newer, discard the draft (or prompt the user).
2. **Always load from API, merge with draft**: Load fresh content on every entry selection, store it in `loadedValues`, then overlay the draft on top. This way, fields not in the draft still show the server value.
3. **Visual indicator**: Show a badge or banner when viewing a localStorage draft vs. saved content, with a "Discard draft" action.
4. **Draft integrity check**: When restoring a draft, verify it has all expected fields from the schema. If fields are missing, discard the draft and reload.

## Files

- `src/editor/Editor.tsx` — load effect that skips API when draft exists
- `src/editor/hooks/useDraftManager.ts` — localStorage persistence and restore logic
- `src/editor/editor-utils.ts` — `normalizeContentPayload` (merges body into form values)

## Resolution (2026-07-24, branch claude/ux-review-fixes)

Fixed via option 2 (always load + overlay) plus draft-lifecycle hardening:

- The entry-load effect in `Editor.tsx` now gates on `loadedValues[contentId]` instead of `drafts[contentId]` — a restored localStorage draft no longer suppresses the API fetch. The draft still overlays the loaded value, but dirty-tracking is truthful and fresh server content is always fetched.
- `handleSave` deletes the draft key after a successful save (previously it was kept forever, which made every subsequent page load look dirty).
- Both discard actions now confirm before destroying differing drafts.

See commit e43b7a6 and `resolved/ux-review-deploy-test-findings.md`. The "visual draft indicator" idea (option 3) was not implemented; the truthful Save-button state now covers the main need.
