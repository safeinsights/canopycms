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
   never hashes the body**, so an OAC-signed origin rejects any multipart POST regardless of
   what the viewer sends. **Measured: `400 InvalidArgument`**, with the response body naming the
   mechanism — `x-amz-content-sha256 must be UNSIGNED-PAYLOAD, ... or a valid sha256 value`.

   Do NOT describe this as a 403. The related note for the Lambda Function URL origin in
   `docs/deploying-to-aws.md` ("CloudFront OAC and request body signing") correctly says 403,
   and the two are different: S3 validates that header's VALUE FORMAT, which is argument
   validation, while Lambda verifies a SIGNATURE over it, which is authorization. An adopter
   told to expect a 403 goes looking for a permissions problem that is not there.
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

## Which distribution does the upload behaviour attach to?

Updated 2026-09-11 after the requesting adopter pushed back on the first answer here and
measured part of it. **Recommendation is now option 3.**

1. **The site's own distribution** (what `AssetSupport.behaviors` assumes today — it is designed
   to be handed to `CanopyCmsDistribution`'s `additionalBehaviors`). Keeps the upload
   same-origin, so `uploadUrl` can be a bare path and the adopter's config names no hostname.
   Costs: a write-capable unsigned origin sits on the distribution serving the public site;
   `CustomErrorResponses` are distribution-wide, so a site mapping 403→404 applies that to S3's
   upload errors and the editor reports the substituted status; and the cookie and
   `Authorization` hazards above are live and must be handled by policy rather than being
   absent.

2. **One distribution dedicated to assets**, serving reads *and* writes for every environment.
   Was the recommendation here; **withdrawn**, for a reason worth keeping written down.

   One assets distribution means one `AssetSupport`, and `AssetSupport` creates the transform
   Lambda. So it also means **one transform Lambda shared by every environment** — and since
   that Lambda ships inside `canopycms-cdk`, a package bump would move every environment's
   asset pipeline at once. Any adopter running a build-once-promote pipeline gives up its
   graduated rollout to get an upload path, which is a bad trade they should not be asked to
   make.

   This entry also described the read side as `/assets/*` and `/assets/t/*` "on an OAC-signed
   origin", which was wrong: `/assets/t/*` is an `OriginGroup` whose primary is the signed S3
   origin and whose 403/404 failover is the transform Lambda
   (`asset-support.ts`'s `buildBehaviors`). Built as described it would serve already-computed
   derivatives and fail every first hit. Corrected here because the elision is what made option
   2 look cheaper than it is.

3. **A distribution dedicated to the UPLOAD ROUTE only** — one behaviour, one unsigned origin,
   nothing else on it. Reads and the transform Lambda stay wherever they already are, per
   environment. **The recommendation.**

   It collects all three structural wins, because they follow from the upload being on a
   *different host*, not from where reads live: no cookies (a cross-origin XHR without
   `withCredentials` sends none), no cached basic-auth credential, and its own
   `CustomErrorResponses` so upload failures keep their true status. None of the read-path
   hazards arise because the read path is not involved, and the transform-Lambda coupling in
   option 2 never comes up. `uploadUrl` is then one absolute URL that is the same for every
   environment.

   It is also the smallest thing to get wrong, which matters given that its defining property is
   that OAC must be **off**.

## Measurements

**Settled (measured by the adopter against a real bucket with NO CORS configuration):** S3
**accepts** a cross-origin presigned POST and simply declines to advertise it. A request
carrying `Origin: https://evil.example.com` returned **204 with no
`Access-Control-Allow-Origin` header**, as did one with no `Origin` at all.

Acceptance and advertisement are independent — bucket CORS governs only whether S3 *advertises*.
That is the property an edge-supplied ACAO needs, and it means a dedicated distribution does not
drag a bucket CORS rule back in. Worth knowing on its own: it is a common assumption that a
bucket CORS rule is what *permits* the upload, and it is not.

**Settled 2026-09-11 — this was the gating question, and the answer is yes.** A CloudFront
response-headers policy DOES supply `Access-Control-Allow-Origin` for a cross-origin presigned
POST against an **unsigned** S3 origin with no bucket CORS configuration: 204, `ACAO: *`, object
landed. Measured by the adopter on throwaway resources (unsigned `HttpOrigin`,
`ALL_VIEWER_EXCEPT_HOST_HEADER`, `NoSuchCORSConfiguration` verified throughout), with the POST
reproduced exactly as `xhr-upload.ts` sends it — presign fields first, `file` last, no custom
headers. **Option 3 is unblocked and has been requested.**

Three further facts fell out of the same run, each previously argued here rather than measured:

- **The presigned-POST signature tolerates a different Host.** The object landed through the
  distribution, so the string-to-sign really is the policy alone.
- **CloudFront forwards a multipart body with field order intact** — S3 would have rejected it
  outright otherwise, since `file` must be last.
- **The edge authorises nothing.** Corrupting the signature and posting through the distribution
  gives 403 with no object landing. Authority remains entirely the presigned policy, which is
  what makes `ACAO: *` scoped to the upload path defensible where a bucket-wide rule is not.

## A caveat for anyone reasoning about per-environment transform Lambdas

Option 2's rejection rests on a per-environment transform Lambda being a rollout boundary. On a
**shared** bucket it is a weaker one than it looks, and this is a property of our key layout
rather than of anyone's infrastructure: transform outputs are content-addressed at
`assets/t/{directives}/{hash32}/{slug}` (`assets/keys.ts`) with **no environment segment**, so
two environments sharing a bucket share derivatives. Whichever environment requests a given key
first computes it, and every other environment is then served that object from cache.

So a per-environment Lambda gates only *which code computes a derivative on first hit, for keys
no other environment has requested yet* — partial and key-dependent, not the clean gate it
reads as. It does not change the recommendation (option 3 sidesteps the question), but an
adopter who believes they have per-environment isolation of transform *output* is mistaken, and
that belief is easy to arrive at. Raised by the adopter against their own argument.

## Related

- `editorOrigins` (`asset-support.ts`) becomes inert for any adopter who takes `uploadUrl` — it
  exists only to write the bucket CORS rule. Still a required prop, since a cross-origin editor
  is the default shape; its doc comment now says so and points here.
- [rename-asset-staging-prefix.md](rename-asset-staging-prefix.md) and
  [cdk-prefixes-duplication.md](cdk-prefixes-duplication.md) touch the same construct.
