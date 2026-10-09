---
priority: P3
adopters: BOTH
summary: >-
  Deferred from request 95. A worker being replaced drains and exits when its instance enters Terminating:Wait, so there is still about 2 minutes with no worker while the replacement boots. A handoff would keep the old worker serving until the successor asks for the lock, cutting the gap to seconds when the ASG launches the replacement in parallel.
---
# [P3] Hand the worker lock to a booting successor instead of draining at once

**Deferred:** 2026-10-09 from adopter request 95, which shipped drain-only. The adopter rated the
gap low priority because queued work survives it.

## The gap that remains

When the ASG targets the worker instance for termination, the worker drains straight away,
completes the `canopycms-worker-drain` hook and exits. The replacement then needs about 2 minutes
(package installs, EFS mount) before a worker runs. Pushes, PR creation and base sync wait that
long on every upgrade.

## Design

1. **Successor side (core).** When `acquireLock` gets ELOCKED, write
   `.tasks/.worker-handoff-request` (requester host and time), then retry the lock every 2 s for a
   bounded wait (about 3 minutes) before exiting as today. That also stops the 5-second
   "Another worker is running" restart loop during a replacement.
2. **Holder side (core).** New `CmsWorker.awaitHandoffRequest(maxMs)` resolves when a request newer
   than the worker's own start appears. Only a worker its entrypoint has told is terminating honours
   one, so a stray second worker can never make a healthy one yield.
3. **Entrypoint (canopycms-cdk).** On `Terminated`, call `DescribeAutoScalingGroups` once. If a
   replacement instance is visibly `Pending` or `InService`, keep serving until the successor's
   request arrives or the window closes (heartbeat − drain − 60 s), then drain, release and
   complete the hook. If none is booting (the ASG launches sequentially), drain at once, as now.
   A spot notice always drains at once.
4. **IAM.** `autoscaling:DescribeAutoScalingGroups` on `*`.

Single-writer still rests on the EFS worker lock: the holder releases it only after draining.

## Open question to settle first

Whether a CloudFormation rolling update launches the replacement while the old instance sits in
`Terminating:Wait`. The instance-maintenance-policy docs say the default for replacements is
"terminate and launch" at the same time, but rolling updates are not in their table. One upgrade's
ASG activity log with the hook in place answers it. If the launch is sequential, the handoff gains
nothing and this task should close.
