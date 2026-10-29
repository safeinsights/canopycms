---
'canopycms-cdk': patch
'canopycms': patch
---

### CloudFront origin read timeout accepted up to 120 s; the editor waits 135 s

<!-- migration
area: CDK
action: Optional
row: Lambda and origin read timeouts may reach 120 s
-->

**What changed.** `CanopyCmsDistribution` and `attachTo` accepted an origin read timeout of at most 60 s, but CloudFront's default quota for "Response timeout per origin" is 120 s. Both now accept up to 120 s and refuse more at synth, with an error that names the quota. A raised quota does not lift the limit, because the editor's request deadline is set just above it: the standard deadline is now 135 s and a branch create's is 150 s, so a standard request that never answers shows its timeout message after 135 s rather than 75 s. Long requests, such as submit, uploads and admin scans, still wait 180 s.

**To adopt.** Nothing is required; the default Lambda timeout is still 60 s. To allow slower requests, pass `timeout: Duration.seconds(120)` (at most) to `CanopyCmsService` and `originReadTimeout: cmsService.timeout` to `CanopyCmsDistribution`.
