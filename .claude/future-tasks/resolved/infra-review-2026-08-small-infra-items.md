# [P3] Three small verified infrastructure defects

From the 2026-08-20 three-round infrastructure review, all **CONFIRMED** at HEAD
`7881e489`. Small, independent, and each cheap to close.

## 1. `CanopyCmsDistribution` only works in us-east-1, undocumented

`cms-distribution.ts:65-70` creates `new acm.Certificate` in the stack's own
region. CloudFront requires its ACM certificate to live in **us-east-1**, so any
stack deployed elsewhere with `CMS_DOMAIN_NAME` set fails — CDK errors at synth
when the region is known, CloudFront rejects at deploy otherwise.

Nothing in the construct, the scaffold, or `docs/deploying-to-aws.md` mentions the
restriction; the scaffold asks for an `AWS_REGION` repo variable with us-east-1
only as an example. An adopter in eu-west-1 follows the docs table, gets a region
error, and has to research it themselves — both workarounds (a pre-created
us-east-1 cert via the `certificate` prop, or a cross-region cert stack) are
undocumented.

**Fix:** throw a descriptive synth error when `Stack.of(this).region` is known,
is not us-east-1, and no `certificate` was supplied — and add the restriction to
the docs table.

## 2. The task queue's `corrupt/` quarantine is never swept

`task-queue/task-queue.ts:410-445` — `cleanupOldTasks` iterates only
`['completed', 'failed']`. Unparseable task files are quarantined into `corrupt/`
by dequeue and orphan recovery (`:610-625`) and surfaced in admin listing, but the
30-day retention sweep never covers that directory, so it grows forever. Deletion
exists only as a manual per-file admin action.

Any recurring producer of malformed task JSON — a partial write surviving a
crash, a bad deploy writing schema-drifted tasks for a week — accumulates files
no automated path removes. Slow leak, bounded impact.

**Fix:** include `corrupt` in `cleanupOldTasks`'s sweep under the same 30-day
stamp-based retention, or sweep it from the worker's sync cycle alongside the
trash-dir cleanup.

## 3. `worker run-once` with a mistyped `CANOPY_AUTH_MODE` skips the auth refresh and exits 0

`cli/cli.ts:212-226` branches on `'clerk'` and `'dev'` only. A value that is
neither — a typo, wrong casing, a stale value from another system — selects no
plugin, and the catch-with-warning around plugin loading only fires on *import*
failures, so nothing warns. `workerRunOnce` (`init.ts:518-527`) then skips the
refresh entirely, because its loud-failure path only covers a refresher that
throws, and the command runs to "Done" with exit code 0.

**Scenario.** A dev-mode deployment refreshes its Clerk cache by cron:
`CANOPY_AUTH_MODE=clerk canopycms worker run-once`. An edit leaves
`CANOPY_AUTH_MODE=Clerk`. Every run from then on exits 0 and refreshes nothing;
the cache ages indefinitely; a user removed from the Clerk org keeps editor
access until someone reads the banner's `auth: <value>` line closely. The
`process.exitCode = 1` signal that exists for refresh *failures* never fires.

**Fix:** validate `CANOPY_AUTH_MODE` against the known set in cli.ts and fail (or
warn + set `exitCode = 1`) on anything else; alternatively have `workerRunOnce`
treat "auth mode names a real provider but no refresher was constructed" as the
same loud-but-non-fatal path as a failed refresh.
