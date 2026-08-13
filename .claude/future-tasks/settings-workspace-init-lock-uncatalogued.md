# concurrency.md credits the settings-workspace init lock with a protection the lock does not provide

Found 2026-08-12 while auditing exclusive-create primitives for the Workstream D
force-with-lease verification
([program-d-stack-rebuild.md](program-d-stack-rebuild.md), item 11).
Independently re-derived twice, in both directions — an earlier draft of this
file had the severity reasoning wrong, and the correction is the finding.

## The headline: a plausible "tidy" would delete the only real protection

[docs/concurrency.md](../../docs/concurrency.md) says the workspace-identity
check "runs entirely inside `ensureGitWorkspace`'s own pre-existing in-memory +
file-based (`O_CREAT|O_EXCL`) init lock … so two hosts racing to initialize the
same settings workspace still can't both decide it's safe and both destroy it."

**That attributes the safety to the lock. It does not come from the lock.**

In `settings-workspace.ts`'s `ensureGitWorkspace`, `acquired` is read exactly
twice: once where it is assigned, and once in the `finally` to decide whether to
*release*. `GitManager.initializeWorkspace` — the call that can reach
`checkout --orphan` + `rm -rf .` — is invoked **unconditionally**. A process that
fails to acquire the lock proceeds into it anyway. There is no early return, no
wait, no retry. This is deliberate; the code says so:

> Deliberately NOT gated on `acquired`: when another process holds the init lock,
> THIS process still proceeds to initializeWorkspace below (pre-existing
> concurrent-init design) …

What actually prevents the wipe is the **rename guard** — the `repoExists` /
`onDifferentBranch` / `looksLikeSettingsBranch || hasSettingsData` check that
throws before `initializeWorkspace` is reached. That guard is **lock-free on
purpose**, and its comment explains why it must be: precisely *because* the
un-locked process continues to `initializeWorkspace`, so skipping the guard there
would let that process wipe a populated workspace.

> ⚠️ **Do not gate the rename guard on `acquired`.** Reading concurrency.md and
> then seeing `acquired` apparently unused makes this look like an obvious
> tidy-up that aligns code with docs. It would **remove the actual protection**
> against an unrecoverable wipe, and it would look like a cleanup in review. If
> the mis-attribution is fixed in the doc first, this trap closes.

## What the lock does and does not buy

The lock is real and does something — it keeps the common case from doing
redundant concurrent work — but it is not a safety barrier for the destructive
path. Two consequences:

- **The 30s expiry is not load-bearing for the wipe risk.** `LOCK_STALE_MS` is a
  fixed 30_000; on `EEXIST` the acquire stats the file, compares
  `Date.now() - mtimeMs`, and if stale **unlinks the live lock** and retries.
  There is no refresh while the holder lives — no heartbeat, no `utimes` — unlike
  Layer 3's `proper-lockfile`, which concurrency.md describes as "auto-refreshed
  while the holder lives" and which can therefore distinguish a crashed holder
  from a slow one. This is worth cataloguing, and a stolen lock does cause real
  mess (redundant concurrent clones into one directory). But since both processes
  enter the destructive path *by design, lock or no lock*, a perfectly held and
  perfectly refreshed lock would not prevent the wipe either. An earlier version
  of this file rated the whole finding on a "how long does init take?"
  measurement; **that measurement does not settle the wipe risk** and should not
  gate the rating.
- **It is uncatalogued.** concurrency.md calls it "a bespoke pair local to
  settings-workspace.ts, **not one of the four numbered layers above** … not yet
  cataloged in the table below", while that same document's maintenance note says
  it is load-bearing and must be updated in the same change as any locking
  change.

## The open correctness question: is the lock-free guard sufficient alone?

This is what a severity rating should actually rest on, and it is unresolved.

The guard reads `repoExists`, then `currentBranch`, then `hasSettingsData`, and
*then* calls `initializeWorkspace` — with nothing excluding another process in
between. Its comment argues it cannot false-positive on a legitimate concurrent
init, and that reasoning looks sound for the cases it enumerates. What it does
not address is the TOCTOU in the other direction: a process that samples the
workspace while it is still empty passes the guard legitimately, and only then
does a concurrent process populate it. Whether that window is reachable in
practice — and what `initializeWorkspace`'s own idempotence check does with it —
needs someone to trace it properly rather than reason from the comment.

## Fix direction

1. **Correct concurrency.md first.** It is the cheap step and it closes the
   dangerous-tidy trap: say the identity check is lock-free by design and that
   the guard, not the lock, is what prevents the double-destroy.
2. **Catalogue the bespoke pair** in the table, with its actual guarantee.
3. **If the lock should genuinely gate init**, moving to
   `acquireProvisioningLock` (Layer 3, already built for "long build-time
   provisioning", and refresh-while-alive) is the right shape — but understand
   it as a **design change, not a timeout swap**: the non-acquiring process would
   have to *wait* instead of proceeding, which is exactly the pre-existing
   concurrent-init behaviour the current comment defends. Do not attempt it as a
   one-liner, and do not "fix" this by raising `LOCK_STALE_MS`, which only trades
   a stolen live lock for a longer block after a crash.

## Confidence

The control flow above was read directly, twice, by two sessions independently,
including a check for an outer early return. It has **not** been executed — no
test reproduces the concurrent-init path today, which is itself part of why this
sat unnoticed.
