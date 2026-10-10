---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-09, from the security review of request 100. Two narrowings left after the worker hardening: the worker role's `AmazonSSMManagedInstanceCore` allows `ssm:GetParameter(s)` on `*`, so a compromised worker reads every Parameter Store value in the account; and the EFS policy does not force clients through the access point, so a principal with broad `elasticfilesystem:Client*` identity permissions that can reach a mount target can mount the root with root access
---
# [P3] Narrow the worker's SSM grant; consider forcing EFS clients through the access point

**Priority:** P3 [BOTH]. **Found:** 2026-10-09, by the security review of
[worker-instance-hardening.md](resolved/worker-instance-hardening.md).

## SSM

`CanopyCmsService` attaches `AmazonSSMManagedInstanceCore` to the worker role for Session
Manager. That managed policy also allows `ssm:GetParameter`, `ssm:GetParameters` and others on
`*`, and a SecureString under the default `aws/ssm` key decrypts for any account principal that
uses SSM. This is the same class as the account-wide EFS policy that request 100 removed.

Replace it with an inline statement listing only what the SSM agent needs for Session Manager and
`send-command`: `ssm:UpdateInstanceInformation`, the association reads, `ssmmessages:*` and
`ec2messages:*`. Check the minimal set against AWS's documentation and against the agent's logs
after a deploy, since a missing action silently breaks the observation channel.

## EFS root mounts

The file-system policy requires TLS and IAM but allows a mount without the access point. Only
the worker and the Lambda are granted, both through the access point, so this matters only for
another principal with broad `Client*` identity permissions (an administrator, or an over-broad
`lambdaRole` passed by an adopter) that can also reach a mount target. Add a
`Deny Client*` to `*` with `StringNotEquals: { 'elasticfilesystem:AccessPointArn': <the AP> }`.
That also blocks operator debugging mounts and any future second access point, so decide whether
the defence is worth it.
