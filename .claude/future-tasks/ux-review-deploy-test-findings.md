# UX Review Findings — Deployed Editor (2026-07-24)

Source: interactive UX review of the AWS test deployment (`https://d1rxq1tjvketcw.cloudfront.net/`, since destroyed) as an admin, exercising: file/branch menus, All Files tree, field editing + live preview, save/draft lifecycle, comments (branch/file/field), branch create/switch/submit/withdraw/delete, media library, field asset picker, layout/highlight toggles.

Caveat: the review tab was occluded, so Chrome throttled timers to 1 Hz — all *speed/animation* observations were discarded as environment artifacts. Findings below are data/state behaviors that reproduce independent of throttling.

Triage note: parallel workstreams were active when this review ran — before picking up any item, check open branches/PRs and existing future-tasks (e.g., [[stale-draft-prevents-content-load]], [[editor-state-context-migration]], [[editor-async-patterns]]) for overlap; some findings may already be in flight.

## P1 — Correctness / workflow integrity

### 1. Header "Submit Branch..." wrongly disabled with false permission tooltip

On a branch the admin had just created and owned, the header Submit button was disabled with tooltip "You do not have permission to submit or withdraw this branch" — while the Branches drawer's Submit button for the same branch was enabled and worked. Persisted across full reload, so it is not just stale client state. The two surfaces compute submit permission differently.

### 2. Save does not clear the localStorage draft → phantom dirty state

After Save File succeeds, the draft (localStorage, `useDraftManager`) is left in place. Every fresh load of that entry then shows Save File enabled with zero user edits; clicking Save performs a no-op save. Worse, branch-level actions key off the same signal: creating a branch popped a false "Unsaved Changes — Create new branch without saving changes?" modal when nothing was actually unsaved. "Discard File Draft" (which fires a "Draft cleared for file" toast) resets the state. Related: [[stale-draft-prevents-content-load]] — same draft-lifecycle root area, different symptom.

### 3. Submitted state invisible and unenforced in the editor

After submitting a branch for review:

- The header status badge disappears entirely (EDITING badge gone, no SUBMITTED badge shown), including after full reload.
- All fields remain editable and Save File succeeds server-side on the submitted branch — no warning, no lock. This undermines the submitted → locked-until-request-changes review model.

### 4. Branch status not synced with actual PR state

Branches whose PRs were merged on GitHub hours earlier (deploy-test PR #1, #2) still showed status SUBMITTED with active "Withdraw" and "Request changes" buttons. Merged/closed PRs should transition the branch (merged/archived) or at least disable withdraw/request-changes. The PR # badge also doesn't appear on a card right after submit (async worker creates the PR) with no "PR being created…" hint.

### 5. `TODO: replace with real modified file list` shipped in two menus

Both the file dropdown and the branch dropdown render a literal "TODO: replace with real modified file list" row, and the branch menu's "1 files modified" header showed a wrong count (listed 2 files) plus a pluralization bug ("1 files").

## P2 — State refresh, naming, formatting

### 6. Header/entry-picker title stale after saving a title change

Saving a new Title updates preview and file, but the top-center header and entry-picker label keep the old title until a full page reload.

### 7. Branch name slash/dash inconsistency

Creating "feature/ux-review-scratch" produced git branch `feature-ux-review-scratch` (slash sanitized to dash), but the URL (`?branch=feature%2Fux-review-scratch`) and header picker show the slash form while the Branches drawer shows the dash form — one branch, two displayed names.

### 8. Raw Clerk user IDs shown as people

Comment authors, "Resolved by", and branch card Owner all render as e.g. `user_3GvkMsA6nd9OLcIDffs2CkHBO48` instead of a display name/avatar.

### 9. Raw ISO timestamps on branch cards

"Updated 2026-07-24T03:54:27.603Z" on branch cards vs. "2m ago" relative times in comments — inconsistent and unfriendly formatting of the same kind of data.

### 10. Destructive actions without confirmation

- "Discard File Draft" discards immediately, no confirm (drafts can hold significant unsaved work).
- Media library per-asset delete (trash icon) — confirmation presence untested; verify it warns, especially for assets referenced by content.

### 11. Media library: no graceful fallback for un-renderable assets

An asset whose source fails the transform pipeline (intentionally corrupt test PNG; `/assets/t/w=160/...` returns 422 JSON `Transform failed: vipspng: libpng read error`) renders as a native broken `<img>`. Show a "preview unavailable" placeholder instead; consider surfacing transform failure state on the card.

### 12. Replace image silently clears Alt text

Picking a replacement image from the library empties the Alt text field with no prompt to re-enter it — easy to ship images with missing alt.

## P3 — Polish

### 13. Comments scope clarity

The Comments panel's default composer creates BRANCH-scoped threads even when opened while editing a file; scope is only hinted by a small "main" subtitle. Branch threads show a "Go to branch" button even when already on that branch. Resolved threads offer no Unresolve/Reply.

### 14. Cancelled inline field-comment leaves empty box

After Cancel on a field's "New comment" composer, an empty "Comments — No comments yet…" section lingers under the field.

### 15. No success toast on Save

Save's only feedback is the button disabling (and a "No changes to save" tooltip if re-hovered). Other actions toast ("Comment added", "Thread resolved", "Draft cleared for file"); Save should too.

### 16. Harness: `/editor` protected but nonexistent

Anonymous `/editor` redirects to Clerk sign-in; after login it 404s (middleware matcher covers a route that doesn't exist in the deploy-test app). Fix matcher or add redirect.

## Design questions (not bugs)

- Admins can edit `main` directly (badge EDITING on main). Intended?
- New branches cut from committed main, so uncommitted working-tree edits made on main don't carry into the new branch; combined with the (false) "Unsaved Changes → Continue Anyway" wording, editors may believe their edits transfer. Clarify messaging/behavior.

## Verified working (for the record)

Live draft preview updates; click-to-focus preview→field highlight; layout + highlights toggles; branch create → switch → submit → PR created on GitHub (verified `gh`) → withdraw → PR converted to draft + status back to EDITING; submit/withdraw/create-with-unsaved confirm dialogs; comment post/resolve with toasts; field asset picker (modal) + media library (drawer) + `/assets/t/` transforms.
