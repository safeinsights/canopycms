---
priority: P2
adopters: BOTH
summary: >-
  RESOLVED (2026-10-10, editor UI epic WS3b) — the protected-branch and status-locked banners' buttons in EditorHeader.tsx use `variant="default"`, as ReadOnlyDraftNotice does, instead of `variant="light" color="yellow"`, which measured about 1.7:1
---
# Yellow banner buttons miss text contrast

`components/EditorHeader.tsx` (protected-branch and status-locked banners) renders each banner's
action as `<Button variant="light" color="yellow">` inside a `color="yellow" variant="light"`
Alert. The editor UX review measured the same style at about 1.7:1 on the read-only draft
notice, which now uses `variant="default"`.

## Fix

Use `variant="default"` for both banner buttons, matching `ReadOnlyDraftNotice`, and confirm
the computed contrast reaches 4.5:1.
