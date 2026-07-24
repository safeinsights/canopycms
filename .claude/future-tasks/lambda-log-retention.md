# Lambda CloudWatch log groups: no explicit retention

Found while implementing worker CloudWatch log shipping
([worker-cloudwatch-logs.md](resolved/worker-cloudwatch-logs.md), 2026-07-24).

## Problem

`CanopyCmsService`'s CMS Lambda and `AssetSupport`'s transform Lambda
(`packages/canopycms-cdk/src/constructs/asset-support.ts`) both rely on the
auto-created `/aws/lambda/<function-name>` log group CloudFormation implicitly
creates the first time the function logs — CDK doesn't manage these groups
unless you say so, so they get **infinite retention** and no `RemovalPolicy`
(they aren't cleaned up on stack teardown). The worker's log group is now the
odd one out: `CanopyCmsService` creates it explicitly with a 90-day default
retention and `RemovalPolicy.DESTROY` (see `workerLogGroup` on the construct).

The deploy-test epic's teardown had to manually sweep leftover
`/aws/lambda/canopy-cms-deploy-test*` log groups after `cdk destroy` — the
Lambda's implicit log groups aren't part of the stack CloudFormation manages,
so `cdk destroy` leaves them behind. Left unmanaged, they also accumulate log
data indefinitely at every adopter's expense.

## Fix

Add explicit `logs.LogGroup` resources for the CMS Lambda and the transform
Lambda, as siblings of the worker's `workerLogGroup` pattern — same shape:
a `retention` prop with a sensible default (e.g. `RetentionDays.THREE_MONTHS`,
matching the worker's default) and `RemovalPolicy.DESTROY` so `cdk destroy`
actually cleans them up. CDK's `lambda.Function` accepts a `logGroup` prop
(or `logRetention`, deprecated in favor of explicit `LogGroup` + `logGroup`)
to point the function at a pre-created group instead of letting CloudFormation
auto-create one on first invoke.

Watch for the naming collision CDK warns about: a Lambda's default log group
name is derived from the function name, so if you create the `LogGroup`
explicitly you must pass a `logGroupName` matching what the function would
otherwise auto-create (or pass `logGroup` directly to the function so CDK
wires it up without ambiguity).

## Related

[[worker-cloudwatch-logs]] — the worker's log group is the model to follow.
