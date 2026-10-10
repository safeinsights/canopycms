---
priority: P3
adopters: BOTH
summary: >-
  System health's "Fix duplicate content IDs" dialog shows the duplicates from the last scan, but `repairContentDuplicates({ dirName })` sends no expected set and the server archives every duplicate it finds at confirm time, so a duplicate created after the scan is archived without being shown. The row's stale "found" badge also stays clickable until the post-repair re-scan lands, so a second confirm 409s
---

# [P3] The duplicate repair can archive more than its dialog showed

Found by the round-1 review of the opt-in duplicate-ID scan and repair UI.

**Consent set ≠ archived set.** `SystemHealthPanel.tsx`'s duplicate dialog lists the kept and
archived paths captured from the last `GET /admin/branch-health?duplicates=1`. On confirm,
`useSystemHealth.repairDuplicateIds` calls `POST /admin/branch-dirs/:dirName/repair-content-duplicates`
with no body. `repairContentDuplicatesHandler` (`packages/canopycms/src/api/admin-branch-health.ts`)
re-derives the duplicates under the content write lock and archives all of them. A duplicate ID
that appeared between the scan and the confirm (a crash inside `renameEntry`, another admin tab) is
archived without the admin having seen it. Which file is kept follows the same deterministic rule
either way, and archiving renames rather than deletes, so nothing is lost; the confirmation simply
did not cover it.

**Stale badge.** After confirm, the row keeps its "found" badge until `checkDuplicateIds()`
returns. A second click opens the same dialog, and its confirm 409s ("No duplicate content IDs
found"), so the admin sees a success toast followed by an error for one action. The repair also
re-runs only the duplicate scan, not `refresh()`, so the row's Updated column lags until the poll.

## Fix direction

- Send the displayed IDs (or dropped paths) in the repair body and 409 when the on-disk set
  differs, so the panel re-scans and re-prompts.
- Mark the row as repairing (badge disabled or a loader) from confirm until the re-scan lands.
