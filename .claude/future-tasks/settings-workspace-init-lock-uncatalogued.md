# The settings-workspace init lock is uncatalogued, unrefreshed, and guards an unrecoverable operation

Found 2026-08-12 while auditing exclusive-create primitives for the Workstream D
force-with-lease verification
([program-d-stack-rebuild.md](program-d-stack-rebuild.md), item 11), and
confirmed independently by #198's session. Two separate problems in one lock: a
documentation gap the doc itself admits, and a liveness gap that may be a real
data-loss path.

## What the lock is and what it protects

`settings-workspace.ts` has a bespoke in-memory + file-based init lock —
`fs.open(lockPath, 'wx')`, i.e. `O_CREAT|O_EXCL` on a regular file, per its own
doc comment at line 28. [docs/concurrency.md](../../docs/concurrency.md) describes
what rides on it: a workspace-identity check that must not let
`GitManager.initializeWorkspace` proceed to `checkout --orphan` + `rm -rf .` on a
populated workspace. The doc is explicit that "orphan branches share no history,
so that sequence is **not recoverable**", and concludes that because the check
runs inside this lock, "two hosts racing to initialize the same settings
workspace still can't both decide it's safe and both destroy it."

## Problem 1 — it is not in the catalogue, and the doc says so

concurrency.md calls it "a bespoke pair local to settings-workspace.ts, **not one
of the four numbered layers above** (it predates this change and is **not yet
cataloged in the table below**)". concurrency.md's own maintenance note says the
document is load-bearing and must be updated in the same change as any locking
change — so an admitted gap guarding an unrecoverable operation is precisely the
kind that stays admitted for a year. That is the cheap half of this task: add the
row.

## Problem 2 — the liveness model differs from Layer 3, in the unsafe direction

This is the part worth measuring before anything else.

`LOCK_STALE_MS = 30_000`, and a lock older than that is `fs.unlink`ed and the
acquisition retried. **There is no refresh while the holder lives** — no
heartbeat, no interval, nothing that extends the lease during a slow critical
section.

Contrast Layer 3, which concurrency.md describes as "auto-refreshed while the
holder lives (`stale` recovers from crashed holders)". `proper-lockfile` can
distinguish a crashed holder from a slow one. This bespoke lock cannot: it infers
death purely from wall-clock age.

So if workspace initialization ever takes longer than 30s, a second host deletes
the first host's live lock, acquires it, and both proceed into the critical
section — at which point the doc's guarantee ("can't both decide it's safe and
both destroy it") no longer holds, and what follows is the `rm -rf .` the doc
calls unrecoverable.

**The atomicity of the acquire is not the issue** — `O_CREAT|O_EXCL` arbitrates
the retry correctly, and item 11's soak will confirm the primitive itself. The
issue is that mutual exclusion has a 30-second expiry that nothing renews.

## First step: measure, then rate

This is filed at P1 because the failure mode is unrecoverable destruction of a
populated workspace, but the true severity turns on **one measurement**: how long
does the guarded critical section actually take, on EFS, at cold start?

- **Reliably well under 30s** → this reduces to Problem 1, a documentation gap.
- **Can exceed 30s under EFS latency or a large settings workspace** → this is a
  live data-loss path and should be re-rated P0.

Initialization involves git operations against a network filesystem at cold
start, which is exactly the profile that produces occasional multi-second-to-
minute outliers, so the measurement should be taken under load rather than on a
warm local disk.

## Fix direction

If the measurement says it matters, do not tune `LOCK_STALE_MS` — a bigger number
trades one failure mode (live lock stolen) for another (crashed holder blocks
init for longer) without fixing either. Prefer moving this to Layer 3
(`acquireProvisioningLock` already exists for exactly this shape: "long
build-time provisioning"), which brings the refresh-while-alive semantics with
it and removes the bespoke pair from the codebase. That also closes Problem 1 by
construction, since Layer 3 is already in the table.
