---
priority: P2
adopters: BOTH
summary: >-
  New 2026-10-13, seen in PR 548's UX walk. A reviewer opening another user's branch they have no ACL entry for gets a toast reading "Schema fetch failed: 403 — no_acl", a raw developer diagnostic, where docs/ux-guidelines.md asks for plain words and diagnostics behind "Details"
---

# "Schema fetch failed: 403 — no_acl" shown to an editor

`hooks/useEntriesData.ts` `fetchEntriesAndSchema` throws `Schema fetch failed: <status> — <error>`
and the load-failure toast shows it as is. In example1, Reviewer One opening User One's branch
saw `Schema fetch failed: 403 — no_acl`.

## Fix

Map a 403 on the branch's schema or entries to plain words ("You don't have access to this
branch's content.") with the way forward, and keep the status and code behind a "Details"
disclosure (docs/ux-guidelines.md, Copy: developer diagnostics). Check why a reviewer, who sees
every branch, is refused here at all: `no_acl` suggests the content guard and the branch listing
disagree on reviewer access.
