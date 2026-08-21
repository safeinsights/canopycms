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
[pr229-review-followups.md](../pr229-review-followups.md) already notes branch-health
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
