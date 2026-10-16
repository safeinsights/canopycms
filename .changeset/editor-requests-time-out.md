---
'canopycms': minor
---

### Editor requests time out instead of hanging

<!-- migration
area: Editing
action: Slow-API browser tests
row: Editor requests time out
-->

**What changed.** Every editor API request has a deadline: 75 s, 90 s for branch create, and 180
s for submit, admin branch scans and repairs, and the proxied upload. Past it the editor says so.
A save keeps your changes. A write with no answer, or a gateway's error page, may still have gone
through, so the editor says that rather than inviting a blind retry, and reloads what it can. The
content and branch-list load failures offer Retry. A comments panel or popover held open by a
write in flight says why.

**To adopt.** Nothing, unless browser tests hold an API response for longer than a deadline to
observe a busy state; keep such holds under it.
