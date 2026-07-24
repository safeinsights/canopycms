# Client-side gating for existing admin panels (Permissions / Groups / Schema)

Confirmed during the git-admin-observability epic (2026-07-24): the epic's new
"System health" menu item is the FIRST admin-gated UI in the Editor.

## Problem

"Manage Permissions", "Manage Groups", and the schema editors render for every
user; only the API's 403s stop non-admins. A non-admin sees the panels, clicks
around, and gets a wall of failed requests — bad UX and needless API noise.
(Server-side enforcement is fine; this is purely client polish.)

## Fix

Gate the sidebar menu items and panel mounts on `isAdmin(userContext?.groups)`
exactly like `Editor.tsx` now does for System health (same optional-callback
prop pattern on `EditorSidebar`). Reviewer-facing pieces (if any) use
`isReviewer`.

## Files

- `packages/canopycms/src/editor/Editor.tsx`, `editor/components/EditorSidebar.tsx`
- Pattern to copy: the `onSystemHealthOpen` threading added by the epic's PR-U1.
