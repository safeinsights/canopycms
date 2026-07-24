# Worker CloudWatch log shipping (REQUIRED for a real deploy)

Spun out of the deployment-test epic (2026-07-24) — flagged as "now REQUIRED, not
optional" in the epic writeup
([resolved/cms-service-deployment-test.md](resolved/cms-service-deployment-test.md))
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
