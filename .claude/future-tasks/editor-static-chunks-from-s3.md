---
priority: P2
adopters: BOTH
summary: >-
  New 2026-10-06, split out of the editor chunk-throttling fix by decision. The editor's chunks come from the CMS Lambda on every CloudFront miss, so a region's first editor load cold-starts one environment per chunk. Serve them from S3 with the Lambda as fallback; the preferred copy is a deploy-time custom resource fetching them serially from the deployed Lambda, not a second build
---
# Serve the editor's static chunks from S3, not the CMS Lambda

## Priority: P2 [BOTH]

Filed 2026-10-06, split out of the editor chunk-throttling fix by decision: that fix raised
`CanopyCmsService`'s `reservedConcurrency` default to 50 and added a synth warning below 20,
which covers the measured burst. This is the structural follow-up.

## The gap

The editor's content-hashed chunks (`/_next/static/*` on `CanopyCmsDistribution`, the
`editorAssetPrefix` route on `attachTo`) come from the CMS Lambda on every CloudFront miss.
CloudFront caches per regional edge cache, so after a deploy the first editor load behind each
cold-starts one Lambda environment per chunk: 14 static requests on example1 (11 JS, 3 CSS),
plus 3 more from the preview iframe, each holding its environment through a cold start. That
costs the user a slow first load, spends Lambda time on static files, and is what the
concurrency cap has to be sized for.

## Why it is not just a `BucketDeployment`

The chunks exist only inside the Docker build, which `cdk deploy` runs as the image asset, and
the generated stack insists that build is the only thing that ships CMS code. A copy in S3 must
match the deployed image byte for byte, or the HTML references chunks S3 does not have.

- **Second build** (CDK bundling against `Dockerfile.cms`'s `builder` stage): runs a full Next
  build on every `cdk synth`/`cdk diff`, and only matches when the Docker layer cache hits or
  Next's chunk hashes are reproducible. Rejected as the primary design.
- **Build once outside CDK** (workflow builds, extracts, pushes to ECR, `fromEcr`): reverses the
  template's deploy model and changes every adopter's workflow.
- **Copy from the deployed Lambda (preferred).** A deploy-time custom resource, ordered after
  the function update, asks the CMS Lambda for its static file list through the Function URL
  (a small internal route under the existing catch-all, so no new adopter touchpoint; the files
  are public build output), fetches each one serially, and writes it to a construct-owned,
  OAC-protected bucket. One build, exact bytes, concurrency 1.

Whichever route: the behavior becomes an origin group with S3 primary and the Lambda as the
403/404 fallback, so a chunk the copy lacks still loads; the upload never prunes, so open
sessions keep their chunks; objects get the year-long immutable `Cache-Control`; both
`CanopyCmsDistribution` and `attachTo` change.

## Done when

A cold editor load after a deploy invokes the CMS Lambda only for the page and its API calls,
asserted in CDK tests (origin group shape, bucket policy, custom-resource ordering) and the
copy step's unit tests.
