# UX Review Findings — Deployed Editor (2026-07-24) — RESOLVED

Source: interactive UX review of the AWS test deployment as an admin (2026-07-24), re-checked against `integration-202607-a`, then fixed on branch `claude/ux-review-fixes`. The original capture lived on branch `claude/canopycms-ui-ux-review-66e834` (now superseded by this file).

## Fix map (commits on claude/ux-review-fixes)

| Finding | Resolution |
| ------- | ---------- |
| False "no permission to submit" tooltip on own new branch; status badge missing after submit; `feature/x` vs `feature-x` name duality | One root cause: client kept the raw branch name after create while the registry stored the sanitized form, so `currentBranch` never resolved. Client now adopts the server's sanitized name (state + URL) and the lookup tolerates raw deep-links. Commit `79fdd89`. |
| Phantom-dirty Save on every load; false "Unsaved Changes" modal on branch create | Save now deletes the localStorage draft after persisting; entry load always fetches the server value (draft becomes a true overlay), so dirty-tracking is truthful. Commit `e43b7a6`. Also resolves [stale-draft-prevents-content-load](stale-draft-prevents-content-load.md). |
| Submitted branches fully editable (no badge, no lock) | Server: `writableBranch` guard 403s on any non-`editing` status (content write/rename, entry create, schema mutations). Client: Save disabled with status tooltip, yellow status-locked banner, entry-tree mutations hidden. Commit `3f74e7f`. |
| "TODO: replace with real modified file list" in both header menus; "1 files modified" | Removed placeholders, fixed pluralization. Commit `3f74e7f`. |
| Header/entry-picker title stale after saving a title change | `onSaved` hook refreshes the entries list after save. Commit `e43b7a6`. |
| Raw ISO timestamps on branch cards | `formatRelativeTime` shared helper (new `editor/relative-time.ts`), used by BranchManager (with full-time tooltip), CommentsPanel, InlineCommentThread. Commits `e2dddae`, `9ff20ac`. |
| Discard File Draft / Discard All without confirmation | Confirm modals when a differing draft would be lost; silent clear otherwise. Commit `e43b7a6`. |
| Broken-image tile for un-transformable assets in media library | `onError` → "Preview unavailable" placeholder in AssetCard. Commit `e2dddae`. |
| Replace image silently clears alt text | Alt preserved on replace (still refocused for review); empty fields unaffected. Commit `e2dddae`. |
| Comments: unclear composer scope, confusing "Go to branch", cancelled inline composer lingering | Scope hint line, renamed to "Open branch discussion", cancel now collapses an empty inline carousel. Commit `9ff20ac`. |
| Branch↔PR status drift (merged PRs stuck SUBMITTED) | Fixed upstream before this branch (worker merge-poll → archived, PR-state badges; PR #144 / git-admin-observability epic). |
| Admins can edit `main` directly | Fixed upstream (protected base branch, PR #153). |

## Explicitly not fixed (with reasons)

- **Raw Clerk user IDs as authors/owners**: the UI already resolves names via `UserBadge` + `onGetUserMetadata`; raw IDs are its documented fallback when the metadata endpoint has no data for the user (the deploy-test instance's condition). Environment/data issue, not a code defect — see existing [user-metadata-caching](../user-metadata-caching.md) / [user-metadata-optimization](../user-metadata-optimization.md) tasks.
- **Unresolve for resolved comment threads**: needs a new comment-store primitive + API route — captured as [comment-thread-unresolve](../comment-thread-unresolve.md).
- **"No save toast" finding**: retracted — the green "Saved" toast already existed; the review environment (throttled hidden tab) obscured it.
- **`/editor` 404 on the deploy-test harness**: harness-specific middleware matcher; deployment being destroyed.
