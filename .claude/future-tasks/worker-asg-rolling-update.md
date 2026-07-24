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
