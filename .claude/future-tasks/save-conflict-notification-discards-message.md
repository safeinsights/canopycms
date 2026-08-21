# [P3] The save path shows a fixed conflict message and discards the server's

**Found:** 2026-08-20, by the independent review of `fix/test-suite-unhandled-errors`.

## Problem

`useDraftManager.ts:601-602` routes *every* 409 to `showConflictNotification()`
(`:426`), which renders a fixed string — "Content was modified by another editor.
Reload to see the latest changes." — and drops `err.message` entirely. Other statuses
(validation, forbidden) do pass `err.message` through, so the conflict case is the
exception.

That is wrong for at least two distinct 409s the server deliberately words differently:

- `BranchSyncingError` — the branch is being rebased right now. Nobody edited anything;
  attributing it to "another editor" misdirects the user.
- The compromise case added with [SYNC-C1]'s per-call-site handling: the write **landed**
  but exclusivity was lost, so the message says to reload before saving again rather
  than to retry. Retrying blind resends a now-stale `expectedVersion` and bounces off
  the user's own landed write as a phantom editor collision.

## Why it is only P3

No data loss: drafts are retained on any failed save (drafts clear only on success), and
the fixed string does say "reload", which is the right action in all three cases. The
cost is a misleading attribution and a wasted retry round-trip.

The server-side wording IS surfaced correctly elsewhere — the rename path
(`api/content.ts:682-684`), admin repair, and logs — so this is specifically the
save-path notification.

## Fix direction

Pass `err.message` through `showConflictNotification()` when the server supplied one,
falling back to the current fixed string. Then soften `content-write-lock.ts:100-106`'s
docstring, which currently claims the wording is load-bearing on the save path — it is
not, until this is fixed. [BOTH]
