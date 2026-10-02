# Body-carrying requests the API client does not sign still 403 behind CloudFront OAC

New 2026-10-01, left over from
[clerk-setactive-server-action-oac-hang.md](resolved/clerk-setactive-server-action-oac-hang.md).
`CanopyCmsDistribution` reaches the Lambda Function URL through OAC (`SigningBehavior: always`).
The Function URL rejects a body without a client-computed `x-amz-content-sha256`, and AWS's docs
say "Lambda doesn't support unsigned payloads". CanopyCMS's API client adds that header to JSON
bodies (`api/request-body-hash.ts`). Nothing adds it to anything else.

## What still 403s

- **An adopter's own Server Actions on the CMS build.** A Next action is a POST with an
  `encodeReply` body and no hash. Clerk's own one is skipped by `useSkipClerkSetActiveAction()`,
  but nothing covers an adopter's. No known adopter has one today.
- **Proxied-store uploads.** `client.assets.uploadProxied` sends `FormData`, whose multipart
  boundary is chosen at send time, so the browser cannot hash it in advance. On AWS the S3 store
  uploads by presigned POST to an unsigned S3 origin (`asset-support.ts`), never the Function URL,
  so this bites only if a proxied store is deployed behind OAC.

`OAC always` cannot be relaxed. On basic-auth tiers it replaces the viewer's `Authorization: Basic`
with SigV4, and `no-override` would forward Basic to the Lambda, which rejects it.

## Candidates, neither started

1. **A payload-hash Lambda@Edge** (origin request, include body), in `canopycms-cdk`. It covers
   both cases, but its limits, from AWS's Lambda@Edge restrictions page, are real:
   - origin-request bodies are truncated at 1 MB, so larger uploads stay broken;
   - it must live in us-east-1 (a cross-region stack via `experimental.EdgeFunction`, and adopters
     bootstrap us-east-1), is x86-only, and takes no env vars;
   - it adds latency to every origin request on the behavior.

   **Unverified:** that OAC signs *after* an origin-request function adds the header. Prove that on
   a deploy before building anything else.
2. **A same-origin fetch shim** on CMS-build pages that hashes string bodies on POSTs lacking the
   header. It covers Server Actions with string bodies, not `FormData`. It must stay same-origin:
   a custom header on a cross-origin request, such as one to Clerk's Frontend API, triggers a CORS
   preflight that the other host would have to allow.

Until one ships, `docs/deploying-to-aws.md` ("CloudFront OAC and request body signing") tells
adopters not to rely on Server Actions in the CMS build.
