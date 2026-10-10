---
priority: P2
adopters: BOTH
summary: >-
  RESOLVED 2026-10-09, branch `feat/worker-bundle-parameter`, stacked on `fix/worker-instance-hardening` (request 99). Opt-in `workerCode: { source: 'parameter' }` on `CanopyCmsService`: a `WorkerBundleSha256` parameter (empty by default, which runs the template's own asset) selects `canopy-worker/<sha256>.js` from a construct-owned, versioned, private, delete-denying bucket, and the same value is what user data checks the download against. Stack outputs carry the parameter's logical id and the bucket. The npm package ships `worker/dist/index.js` with `index.js.sha256`, and a test proves the build byte-reproducible. The default stays `'asset'`
---
# Let an adopter's CI roll the worker without a template change

**Status: RESOLVED 2026-10-09**, branch `feat/worker-bundle-parameter`; see the summary.

**Priority:** P2 [BOTH]. **Found:** 2026-10-09, request 99.

## Problem

The worker bundle is a CDK asset whose S3 key is interpolated into the launch template's user
data. An adopter that deploys the editor with parameter-only change sets (`--use-previous-template`
and an image-digest parameter) could never move the worker that way, so every canopycms bump left
the editor new and the worker old ("API and worker versions differ") until someone ran
`cdk deploy`.

## Resolution

`workerCode: { source: 'parameter' }` (packages/canopycms-cdk/src/constructs/worker-bundle.ts),
pinned by `worker-bundle-parameter.test.ts`. One parameter, rather than a key plus a hash, both
names the object and is the value it is checked against, so the two cannot disagree. An empty
parameter falls back to the template's own bundle through a CloudFormation condition, so the
first deploy into parameter mode needs nothing uploaded. The bundle ships as the single esbuild
file rather than a zip: the output is byte-stable, so no zip library is needed and the instance
has nothing to unpack. The CI procedure, with the caveat that `cdk deploy` keeps a parameter's
previous value, is in `docs/deploying-to-aws.md#rolling-the-worker-from-ci`.
