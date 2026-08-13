# Worker ASG has no update policy — deploys don't actually update the worker

Found while planning the pre-merge sandbox verification of
[[worker-cloudwatch-logs]] (PR #145, 2026-07-24): to exercise the new
user-data we had to manually terminate the instance, because a `cdk deploy`
alone never would have.

## Problem

`CanopyCmsService`'s worker ASG (`cms-service.ts`, `WorkerAsg`) sets no
`updatePolicy`. CloudFormation's default for an ASG behind a changed launch
template is to update the template and do **nothing else** — the running
instance keeps the old user-data and old worker bundle until the next spot
interruption or a manual terminate.

This bites in two ways:

- **Config changes** (user-data edits like the CloudWatch agent block, env
  file contents, systemd unit): deployed stacks silently keep running the old
  bootstrap.
- **Worker code changes**: the worker bundle ships as a CDK S3 asset whose
  hash appears in the `aws s3 cp` user-data line, so a code change *is* a
  launch-template change — and likewise doesn't reach the running instance.

An operator reasonably assumes `cdk deploy` deploys. Today it deploys
everything except the worker.

## Fix direction

Add a rolling/replacing update policy to the ASG, e.g.:

```ts
updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({
  minInstancesInService: 0, // single-instance ASG: brief downtime is fine
})
```

Considerations:

- min/max capacity are both 1, so `minInstancesInService: 0` is required —
  the update is terminate-then-relaunch with a short worker outage. That's
  acceptable: the task queue and workspaces live on EFS and the worker picks
  them up on boot; Save/Publish enqueue paths in the Lambda are unaffected.
- No cfn-signal in user-data today: CFN considers the new instance done when
  EC2 reports it healthy, not when the worker actually starts. Good enough
  (matches the existing EC2-level ASG health check); adding cfn-signal after
  `systemctl start canopy-worker` would make deploys fail fast on bootstrap
  regressions (e.g. the systemd#27591 crash-loop class) and is worth
  considering while in there.
- Interim workaround (document until fixed): after a deploy that touches the
  worker, terminate the instance and let the ASG relaunch it.

## Related

[[worker-cloudwatch-logs]] — the deploy-verification friction that surfaced
this.

## Resolution (2026-07-30, `fix/cdk-deploy-reaches-worker`, PR #176)

`CanopyCmsService`'s worker ASG now sets
`autoscaling.UpdatePolicy.rollingUpdate({ minInstancesInService: 0 })`. The `0`
is required rather than merely chosen: min and max capacity are both 1, so
there is no way to hold an instance in service out of a maximum of one. Deploys
are terminate-then-relaunch with a short worker outage while the replacement
boots.

**cfn-signal was deliberately not added**, contrary to this file's "worth
considering" note, and the reasoning is recorded in a comment next to the
update policy so it is not re-litigated:

- User-data runs under `set -euo pipefail`, and the CloudWatch-agent block is
  last *on purpose* so an agent failure cannot kill the boot. A `cfn-signal`
  placed after it would never run when that block fails, so CloudFormation
  would wait out its timeout and **fail and roll back the whole deploy** — the
  opposite of the intent.
- Placed earlier it proves almost nothing: the systemd unit is `Type=simple`
  with `Restart=always`, so `systemctl start` returns 0 the instant exec
  succeeds. A worker that immediately crash-loops would still signal SUCCESS.
  A real readiness gate would have to poll `worker-status.json`.

**A prerequisite this exposed and fixed in the same PR:** rolling the ASG turns
instance replacement from rare into routine, and orphaned-task recovery ran
exactly once, at `start()`. A replacement boots in 2–4 minutes, *under*
`recoverOrphanedTasks`'s 5-minute staleness threshold, so that single call saw a
just-orphaned task as too fresh and skipped it — and nothing rescanned
`processing/` afterwards. The task, and its branch's `syncStatus`, would have
wedged forever. Recovery now runs every task-queue cycle, which is safe because
`taskTimeoutMs` is 60s.
