# Worker-side self-heal for a poisoned pre-existing remote.git

Deferred from the git-admin-observability epic (2026-07-24) — surfaced-not-actioned
by design; see the epic's adversarial review (deferral 3.6).

## Problem

`CmsWorker.ensureRemoteGit()` auto-deletes and re-clones a poisoned `remote.git`
only when the poisoning is detected immediately after a fresh clone. For an
*already-existing* poisoned bare repo it refuses to auto-delete and prints
"Delete `<path>` and restart the worker" — an instruction nobody can follow in
prod (no shell/EFS access). The epic made the state *visible* (the startup
failure now lands in `worker-status.json` → System health panel red alert), but
recovery still needs an operator.

A Lambda-side "reset remote.git" admin action was considered and rejected: it
races the systemd restart loop's re-clone, and deletion can destroy unpushed
`canopycms-settings-*` branches — the precise reason the worker refuses today.

## Fix (worker-side, safe)

In `ensureRemoteGit`'s already-exists path: enumerate refs that exist locally
but not on GitHub (unpushed work). If there are NONE, auto-delete + re-clone
(same as the fresh-clone path — nothing can be lost). If there ARE unpushed
refs, keep refusing, but include the ref list in the error so the panel shows
exactly what's at stake.

## Files

- `packages/canopycms/src/worker/cms-worker.ts` (`ensureRemoteGit`)
- Tests follow `cms-worker.test.ts`'s empty-remote-guard scenarios.
