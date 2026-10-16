---
adopters: BOTH
summary: >-
  RESOLVED (2026-08-21, epic `epic/infra-review-2026-08`) — `CanopyCmsDistribution` passed no `readTimeout`, so aws-cdk-lib omitted `originReadTimeout` entirely and CloudFront's **30s** service default capped the CMS Lambda's 60s budget: every request in the 30-60s band was answered 504 at the edge while the invocation ran to completion behind it (first-touch branch provisioning does a full `git clone` onto EFS inside the request). The two values now come from ONE exported constant, `DEFAULT_CMS_LAMBDA_TIMEOUT`, and `CanopyCmsService` exposes its resolved `timeout` so an override can be wired straight into the distribution — which the scaffold template now does. A synth test asserts the emitted `OriginReadTimeout` equals the Lambda `Timeout` and is never absent, and a timeout above CloudFront's 60s ceiling now fails at SYNTH with a message naming the service-quota increase, rather than deploying a config that 504s. `AssetSupport.buildBehaviors()`'s accidental 30/30 match is now explicit too
---
# [P2] CloudFront's 30s origin read timeout silently caps the CMS Lambda's 60s budget

Found by the 2026-08-20 three-round infrastructure review (round 2) at HEAD
`7881e489`. **CONFIRMED** against aws-cdk-lib 2.244/2.265 source.

## The defect

`cms-distribution.ts:81` builds the origin as
`origins.FunctionUrlOrigin.withOriginAccessControl(props.functionUrl)` with no
`readTimeout`. In aws-cdk-lib the property is emitted as
`originReadTimeout: this.props.readTimeout?.toSeconds()` — omitted entirely when
unset, so CloudFront's service default of **30 seconds** applies.

The CMS Lambda's own timeout is **60 seconds** (`cms-service.ts:461`,
`timeout: props.timeout ?? Duration.seconds(60)`). Every request that lands in
the 30–60s band is answered 504 by CloudFront while the Lambda invocation
continues to completion behind it.

This is not hypothetical for this codebase: first-touch branch provisioning does
a full `git clone` onto EFS inside the request, and
[pr229-review-followups.md](pr229-review-followups.md) already notes branch-health
scans running "inside a 60s Lambda".

## Failure scenario

The KB deploys. An editor opens a new branch on the sizeable repo; workspace
provisioning (clone + checkout onto EFS) takes 40s. At 30s CloudFront returns 504
and the editor surfaces a failure. The user retries, hits the provisioning lock
(`ELOCKED` → 409) or a second slow path, and concludes the deployment is broken —
while the first invocation actually **succeeded** at 40s.

Every long admin operation (branch health scan, large publish submit) has the
same split brain: server-side success, viewer-facing 504, and nothing in either
log explaining the other half.

## Fix direction

Pass `readTimeout: Duration.seconds(60)` on the `FunctionUrlOrigin` in
`CanopyCmsDistribution`, matching the Lambda timeout — and parameterize the two
together if `props.timeout` is exposed, so they cannot drift. CloudFront accepts
up to 60s without a quota increase.

Consider the same explicit pairing in `AssetSupport.buildBehaviors()`: the
30s/30s match there is accidental, not asserted.
