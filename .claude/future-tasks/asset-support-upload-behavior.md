# `AssetSupport` cannot emit the CloudFront behaviour that `media.uploadUrl` needs

**Status:** Open. **Priority: P2.** Filed 2026-09-10 alongside the change that added
`media.uploadUrl` (adopter request #44).

## Problem

`media.uploadUrl` lets an adopter point presigned uploads at their own CloudFront distribution
instead of the S3 REST endpoint, which makes the upload same-origin and removes the need for a
bucket CORS rule naming an exact origin. The package half shipped. The **infrastructure half did
not**, and `canopycms-cdk`'s `AssetSupport` cannot express it today.

Three things an upload behaviour needs, none of which `AssetSupport` can produce:

1. **An S3 origin with OAC signing off.** `buildBehaviors()` has exactly one S3 origin,
   `origins.S3BucketOrigin.withOriginAccessControl(this.bucket)`
   (`packages/canopycms-cdk/src/constructs/asset-support.ts`), shared by both behaviours. OAC is
   a property of the *origin*, not the behaviour, so the upload path needs a **second origin
   entry for the same bucket**. With `SigningBehavior: always` CloudFront re-signs the request
   with its own credentials — and, more fundamentally, **CloudFront signs origin requests but
   never hashes the body**, so an OAC-signed origin rejects any multipart POST with a 403
   regardless of what the viewer sends. That constraint is already written down for the Lambda
   origin in `docs/deploying-to-aws.md` ("CloudFront OAC and request body signing"); an adopter
   wiring this by hand meets it from the other direction and has to re-derive it.
2. **`allowedMethods: ALLOW_ALL`.** Both existing behaviours omit `allowedMethods` and so take
   CDK's `ALLOW_GET_HEAD` default. A POST is 405 without it.
3. **A viewer-request URI rewrite to `/`.** S3's POST Object is only valid at the bucket root;
   without the rewrite the upload gets `405 MethodNotAllowed`.

Plus an origin-request policy forwarding **no cookies** — a same-origin upload path otherwise
receives the site's cookies, including the editor session cookie, which would reach S3 and its
access logs — and, for a site behind HTTP basic auth, stripping `Authorization` (forwarded to S3
it produces `400 InvalidArgument — Unsupported Authorization Type`).

## Why it is worth doing

Every adopter who takes `uploadUrl` hand-rolls all of the above, and the OAC trap in particular
is silent-until-403 and non-obvious. The first adopter already measured the whole path end to
end and hit each item; the second should not have to.

## Open design question, to settle first

**Which distribution does the upload behaviour attach to?** Two shapes, and the choice changes
the API:

1. **The site's own distribution** (what `AssetSupport.behaviors` assumes today — it is designed
   to be handed to `CanopyCmsDistribution`'s `additionalBehaviors`). Keeps the upload
   same-origin, so `uploadUrl` can be a bare path and the adopter's config names no hostname.
   Costs: a write-capable unsigned origin sits on the distribution serving the public site;
   `CustomErrorResponses` are distribution-wide, so a site mapping 403→404 applies that to S3's
   upload errors and the editor reports the substituted status; and the cookie and
   `Authorization` hazards above are live and must be handled by policy.
2. **A distribution dedicated to assets**, next to the bucket, shared across environments.
   Three of those hazards stop existing rather than needing to be configured correctly, because
   it is a different host: no cookies (cross-origin XHR without `withCredentials` sends none),
   no basic-auth credential, and its own `CustomErrorResponses`. The upload becomes cross-origin
   again — but `multipart/form-data` is a CORS-safelisted content type and a presigned POST
   sends no custom headers, so there is **no preflight**; only an `Access-Control-Allow-Origin`
   on the response is needed, and that can come from a CloudFront response-headers policy rather
   than from the bucket. On this path CORS is not the security boundary — the presigned policy
   is — so `ACAO: *` scoped to the upload behaviour is defensible and removes origin
   enumeration entirely. Would also be a **new supported topology** for `AssetSupport`, and puts
   the transform Lambda's Function URL origin cross-account (contemplated already; that is what
   `transformRole` exists for).

**Unverified, and it gates option 2:** that a CloudFront response-headers policy supplying ACAO
is sufficient with *no* bucket CORS configuration for a cross-origin presigned POST. Reasoned
from the CORS safelist, not measured. Measure it before building option 2.

## Related

- `editorOrigins` (`asset-support.ts`) becomes inert for any adopter who takes `uploadUrl` — it
  exists only to write the bucket CORS rule. Still a required prop, since a cross-origin editor
  is the default shape; its doc comment now says so and points here.
- [rename-asset-staging-prefix.md](rename-asset-staging-prefix.md) and
  [cdk-prefixes-duplication.md](cdk-prefixes-duplication.md) touch the same construct.
