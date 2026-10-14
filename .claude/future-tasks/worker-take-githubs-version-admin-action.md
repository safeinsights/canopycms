---
priority: P2
summary: >-
  New 2026-10-11. A branch the worker keeps diverged from GitHub (it holds editor work and GitHub's
  branch was rebased or force-pushed) has no in-app fix: purge refuses a live branch, Delete Branch
  also deletes a published branch on GitHub, and nothing copies a branch's work. Add an admin
  "Take GitHub's version" action that resets the workspace and remote.git head to GitHub's tip.
---

# An admin action to take GitHub's version of a diverged branch

## Priority: P2

Found 2026-10-11 while building the tracked-branch-diverged fix
([tracked-branch-diverged-forever.md](resolved/tracked-branch-diverged-forever.md)).

## Problem

The worker now moves a stale copy of a rebased GitHub branch to GitHub's tip by itself. A copy
that holds editor work (a branch workspace, a queued push) is kept, listed as diverged in System
health, and warned about once. What an operator can do about it today is poor:

- **Purge** (System health, Branches tab) refuses a directory holding a live `branch.json`
  (`api/admin-branch-health.ts`, 409 "Directory holds a live branch; use branch delete").
- **Delete Branch** in the editor deletes the branch on GitHub too once it has been published
  (`api/github-sync.ts` `syncDeleteRemoteBranch`), which is the developer's rebased branch, and
  is refused while the branch is in review.
- Nothing copies a branch's work into a new branch: new branches always start from the base.

So the panel's copy tells a developer to push GitHub's version to a new name before deleting
this branch, and tells editors their changes must be re-entered by hand.

## Proposed fix

An admin-only action on a diverged branch, "Take GitHub's version":

1. Under the branch's provisioning lock and content-write lock, move the workspace aside into the
   trash (as purge does, reversible for the trash retention window).
2. Lease `remote.git`'s `refs/heads/<name>` from the diverged local tip to GitHub's tip (the
   gateway's latest fetch), as `worker/stale-mirror.ts` does.
3. Re-provision the workspace from the branch's new head, keeping `branch.json`'s identity (PR
   number, ACLs, status as appropriate), or leave the branch unprovisioned for the editor to
   reopen.

Open questions: whether this runs in the Lambda (it can write both) or as a worker task (the
worker owns ref moves today), what happens to the branch's comments and status, and whether
re-provisioning from a non-base head needs a new provisioning path (today `checkoutFreshClone`
always branches from the base).
