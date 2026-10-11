---
priority: P2
adopters: BOTH
summary: >-
  New 2026-10-10, from the editor UI epic's WS3 UX review. Submitting a branch for review while the open entry has unsaved edits gives no warning that those edits are not included; they are then kept as a hidden draft on the now read-only branch
---
# Warn when submitting with unsaved changes

In example1, typing into an entry and then submitting the branch submitted only the saved
content, with no prompt. The unsaved edit survives as a kept draft behind
`ReadOnlyDraftNotice`, so nothing is lost, but the editor believed it had submitted it.

## Fix

Before submit, call `resolveUnsaved` (`hooks/useDraftManager.ts`, already used by branch switch
and create) and confirm: "N entries have unsaved changes that won't be submitted." with Save
first and Submit anyway.
