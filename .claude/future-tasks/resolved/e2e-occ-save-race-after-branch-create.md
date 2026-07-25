# Intermittent OCC 409 when saving immediately after branch create/switch

**Priority:** P1 → **RESOLVED 2026-07-25** (root cause found by Playwright trace; fixed in `useEntryManager.ts`)

## Original symptom

Full `pnpm test:e2e` runs intermittently failed a save right after branch
create/switch with 409 + "Content was modified by another editor"; never
reproduced in isolation. Original hypothesis (WRONG): an unidentified
server-side process touching the branch clone's file mtime post-provisioning.

## Actual root cause (proven)

Client-side, not server-side. The editor's OCC version map
(`entryVersionsRef` in `editor/hooks/useEntryManager.ts`) was keyed by
`contentId` alone — but the token is a file **mtime, which is per-branch**
(each branch clone has its own file). The branch-change effect cleared the
map, but a **late-resolving load response from the previous branch**
repopulated it after the clear, so the next save sent the OLD branch's mtime
with a NEW-branch-targeted write → 409.

Proof (Playwright trace of the deterministic post-UX-epic repro): the failing
`PUT /api/canopycms/conflict-test-<ts>/content/home` carried
`expectedVersion` equal to **main's** home.json mtime; the only prior content
GET in the trace targeted `main`. The UX-review epic's draft-lifecycle rework
(e43b7a6) turned the race from intermittent into deterministic under full-run
load, which is what made it diagnosable.

## Fix

Key the version map by `${branch}:${contentId}` and pin the request's branch
in `loadEntry`/`saveEntry` closures so tokens are recorded under the branch
that actually served them. A late previous-branch response now lands under
the old branch's key and cannot poison the new branch's saves. The
branch-change `clear()` remains as growth bounding only.

Verified: the 3-spec deterministic repro (branch-workflow + comments +
conflict-management) and back-to-back full-suite runs pass; editor unit
project green.
