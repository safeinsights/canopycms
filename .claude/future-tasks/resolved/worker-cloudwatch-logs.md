# Worker CloudWatch log shipping (REQUIRED for a real deploy)

## Status: RESOLVED (2026-07-24, PR #TBD)

### What shipped

`CanopyCmsService` now ships the EC2 worker's stdout/stderr to a dedicated
CloudWatch log group by default via the amazon-cloudwatch-agent (installed and
configured in worker user-data, since the agent cannot read journald — the
systemd unit was switched from `StandardOutput=journal` to a file at
`/var/log/canopy-worker/worker.log`, bounded by a logrotate policy). The log
group has a predictable name (`/canopycms/<stackName>/worker`, overridable via
`workerLogGroupName`) and a 90-day default retention (overridable via
`workerLogRetention`), both exposed as `CanopyCmsServiceProps`, with the group
itself exposed as `service.workerLogGroup`. The worker role's IAM grant is
scoped to exactly `logs:CreateLogStream`/`logs:PutLogEvents` on that one log
group — no broad `CloudWatchAgentServerPolicy`, no `CreateLogGroup` (the group
is CFN-managed so retention/removal policy stay under CDK's control). The
agent install/config is ordered *after* `systemctl start canopy-worker` in
user-data so a yum/agent failure never prevents the worker itself from
running (log shipping is deliberately best-effort).

Original description below.

---

# Worker CloudWatch log shipping (REQUIRED for a real deploy)

Spun out of the deployment-test epic (2026-07-24) — flagged as "now REQUIRED, not
optional" in the epic writeup
([resolved/cms-service-deployment-test.md](cms-service-deployment-test.md))
but never captured as its own task file until now.

## Problem

During the live prod-mode deploy, the CmsWorker EC2 instance was a black box: the
human SSO role (`SafeInsights-DevAdmin`) cannot `ssm:StartSession` or
`ssm:SendCommand`, so the only observability was EC2 console output plus EFS
CloudWatch metrics. Diagnosing worker behavior (sync cycles, submit/PR pushes,
crashes) required inference from side effects.

The Lambda and transform Lambda already log to CloudWatch; the worker is the only
runtime component without shipped logs.

## Fix directions

- Ship the worker's journald/stdout to CloudWatch Logs — add the CloudWatch agent
  (or `awslogs`) in the `CanopyCmsService` worker user-data, with an IAM policy for
  `logs:CreateLogStream`/`PutLogEvents` on a dedicated log group.
- And/or grant SSM Session Manager to the operating role so a human can shell in.
  (Instance role likely needs `AmazonSSMManagedInstanceCore`; check whether the
  SSO role restriction also blocks session initiation — if so, agent-based log
  shipping is the only path.)
- Wire the log group into the CDK construct so adopters get it by default; consider
  a retention setting.

## Why it matters

[[post-merge-sync-gaps]] Gap 2's root cause could not be confirmed on the live
deploy precisely because of this gap ("Root cause to confirm on a host with shell
access — this deploy's SSO role can't SSM in"). Any production incident involving
the worker is currently undebuggable.

Relates to [[project-deployment-test-epic]].
