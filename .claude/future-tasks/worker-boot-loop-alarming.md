---
priority: P2
adopters: BOTH
summary: >-
  Nothing pages anyone when the worker is down, including a deterministic boot loop: the fail-fast `ERR` trap turns one dead instance into churning ones, and the admin panel's "absent" state needs someone looking. **Decided:** an optional alarm-topic prop (`alarmTopic?: ITopic`) in `canopycms-cdk`, with a CloudWatch alarm on worker log-event rate or ASG launch churn. Part of the worker-down cluster with `worker-not-ready-permanent-failure` and `worker-secret-errors-before-start-are-invisible`
---
# [P2] Nothing pages a human when the worker is down, including a boot loop

**Priority: P2 [BOTH], due now:** the worker is live on a deployed site. Part of the worker-down
observability cluster; see [worker-not-ready-permanent-failure.md](worker-not-ready-permanent-failure.md).

**Decided:** ship an optional alarm-topic prop in `canopycms-cdk` (`alarmTopic?: ITopic` on the
service construct). Every adopter on this shape needs it and the spot worker makes boot failures
routine. With no topic passed, no alarm or subscription is created, so the default stays
dependency-free.

Found by the independent Fable security review of `epic/infra-review-2026-08`
(2026-08-21), rated MEDIUM. Filed rather than fixed because the fix needs a
notification endpoint, which is JP's to choose.

## What the epic changed, and what it left

The epic added a fail-fast `ERR` trap to the worker's user-data: a failed boot
step now `shutdown -h now`s, the instance fails its EC2 health check, and the
ASG replaces it. That fixed the reported defect — a **transient** failure
previously left a permanently dead instance while `cdk deploy` reported success.

It does not fix the **deterministic** case. If a boot step fails every time —
`dnf install -y nodejs22` against a renamed/removed package, `/usr/bin/node-22`
not being the real binary path, or any user-data bug — then: retry exhausts →
trap fires → shutdown → ASG replaces → identical failure → forever. No backoff,
no circuit breaker.

## Honest framing of the severity

The loop is **not a regression**. Before the trap, a deterministic failure gave
one silently-dead instance; now it gives silently-churning instances. Both leave
the worker down (publishes queue on EFS, the auth cache goes stale, PRs stop).
On t4g.nano spot the money is negligible.

It is also **not invisible**: `api/admin.ts` reports
`worker: { state: 'absent' }` (`WorkerLivenessState`), which the admin panel
surfaces, and ASG launch churn shows in the console and in CloudWatch's
`GroupTotalInstances`. The real gap is narrower than "nothing notices": **nothing
notifies**. Someone has to be looking.

The scope of the trap is now correct — it is disarmed (`trap - ERR; set +e`)
before the best-effort CloudWatch section, so a package-mirror outage there can
no longer shut down a healthy worker. A synth test asserts that ordering.

## Why a circuit breaker is not the obvious fix

The natural design — a marker on EFS recording "this boot already failed at
step N, do not shut down again" — does not reach the failure that matters. EFS
is mounted by `amazon-efs-utils`, which is itself a `dnf install`, so the
package-install failures happen **before** EFS is available. Each replacement is
a fresh instance with no local state to carry forward. Any real breaker needs
external state, which means the alarm path below anyway.

## Fix direction

Alarm on worker absence rather than on the loop:

1. A CloudWatch alarm on the worker log group's log-event rate falling to zero
   for N minutes, or on the ASG's instance-launch rate exceeding a threshold
   (churn), or both.
2. The alarm action targets an SNS topic the adopter supplies (a real email/Slack/PagerDuty
   subscription is theirs to create; a placeholder in the construct would be worse than nothing).
3. Expose it as the optional construct prop (`alarmTopic?: ITopic`) so adopters without a notification
   channel are unaffected and the default stays dependency-free.

Worth pairing with the existing admin-panel signal so the two agree on what
"worker down" means.

## Trigger

Met: a deployed site's editors depend on the worker (publishes, the auth cache). The admin panel's
absent-worker state is the only signal until the alarm lands.
