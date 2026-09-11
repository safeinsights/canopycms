# `AssetSupport` cannot emit the CloudFront behaviour that `media.uploadUrl` needs

**Status: RESOLVED 2026-09-11**, branch `feat/asset-support-upload-behavior`, base
`int-202608-b`. Filed 2026-09-10 alongside the change that added `media.uploadUrl`.

Shipped as `AssetSupportProps.uploadBehavior` + `AssetSupport.uploadBehavior()` in
`packages/canopycms-cdk/src/constructs/asset-support.ts`, built to **option 3** below: the
behaviour is meant to be the default behaviour of a distribution serving the upload route and
nothing else. It emits an unsigned origin for the bucket, `ALLOW_ALL`, a viewer-request
CloudFront Function, an origin-request policy forwarding no cookies and no query strings and
excluding `host`, and a response-headers policy supplying `ACAO` (default `['*']`, overridable
via `allowedOrigins`). The function does three things: rewrites the URI to `/`, deletes
`Authorization`, and answers the CORS preflight.

## The finding that changed the design, found in review round 2

**This route needs a preflight responder, and the measurements below could not have shown
that.** They replayed the POST as a script; a scripted POST has no preflight.

The editor's upload is not a CORS simple request, though it reads like one. `xhr-upload.ts`
sends `multipart/form-data` with no custom headers — but it assigns `xhr.upload.onprogress`
before `send()`, and registering ANY listener on the `XMLHttpRequestUpload` object disqualifies
a request from the simple-request rules on its own, independent of method, headers and content
type. So every browser upload begins with `OPTIONS /`.

Nothing else would have answered it. CloudFront does not synthesize preflight responses (a
response headers policy supplies values for headers *in responses to* preflight requests — it
decorates a response something else produced), and `ALLOW_ALL` forwards the OPTIONS to S3,
which with no CORS configuration answers `403 CORSResponse`. A preflight that is not 2xx fails
the browser's check whatever headers are attached, so **on the exact topology recommended here
the POST would never have been sent at all.**

The lesson generalises past this task: a scripted POST is not an acceptance test for a
browser upload path. Anything that turns on CORS has to be exercised by a browser.

Four further decisions taken during implementation that this file did not anticipate:

- **`HttpOrigin`, not `S3BucketOrigin.withBucketDefaults()`.** Both are unsigned, but
  `HttpOrigin` is the exact shape measured end to end below, and it is the only one that can
  pin the CloudFront->S3 protocol — `withBucketDefaults()` emits `S3OriginConfig`, which has no
  `OriginProtocolPolicy` field. For a request carrying a live upload credential in its body,
  that leg should be stated rather than inferred.
- **`HTTPS_ONLY`, not the read behaviours' `REDIRECT_TO_HTTPS`.** CloudFront redirects with
  301, and a browser turns a 301'd POST into a GET — so an `http://` upload URL would silently
  become a bodyless GET, rewritten to `/` and refused, with the file never sent. `HTTPS_ONLY`
  answers 403: the same refusal, visible.
- **The URI rewrite is a containment mechanism, not only a functional one.** Rewriting
  unconditionally means nothing arriving on this behaviour can address a key, so `ALLOW_ALL`
  buys an anonymous caller only bucket-level operations at `/`, all of which the bucket's
  BLOCK_ALL stance already refuses. This is why the rewrite must never be made conditional.
- **`editorOrigins` became optional** rather than staying required (see Related, below, which
  is now out of date on that point). Standalone mode refuses to synth with neither it nor
  `uploadBehavior`, and an empty array counts as absent. BYO-bucket mode is untouched: the
  caller owns that bucket's CORS configuration and the construct cannot read it.

Review rounds then added a set of fail-closed guards, each for a failure that would otherwise
have deployed clean and failed silently in a browser:

- `allowedOrigins` entries are matched EXACTLY at the preflight, so a leftmost-subdomain
  pattern (which the response headers policy would happily accept) is refused at synth rather
  than half-honoured. `'*'` counts only as the sole entry.
- An empty `allowedOrigins` is refused rather than defaulting to the wildcard.
- A dotted BYO bucket name is refused: S3's wildcard certificate covers one label, so
  `my.docs.bucket.s3.<region>.amazonaws.com` fails TLS to this *custom* origin and CloudFront
  answers 502. The read path uses an S3-type origin and is unaffected.
- Setting `uploadBehavior` and never calling `uploadBehavior()` fails synth — otherwise the
  standalone guard is satisfied while nothing supplies ACAO from anywhere.

**Testing note worth carrying forward:** the first tests for the edge function asserted on
fragments of its emitted SOURCE, and a real matcher bug passed all of them — the code contained
every expected fragment and still answered the wrong thing. The tests now load the emitted
`FunctionCode` into `node:vm` and run it against CloudFront-shaped events. 25 tests for this
feature; 33 source mutations verified across three review rounds, each red on its intended
test, two of them re-run after tests were consolidated.

`ASSET_BEHAVIOR_SPREAD_MISTAKE_KEYS` was considered and deliberately **not** extended:
`uploadBehavior()` returns a bare `BehaviorOptions` rather than a named property, so there is
no spread to get wrong, and a speculative `'upload'` entry would misfire on an adopter whose
distribution has a real upload route (CloudFront treats a path pattern's leading slash as
optional, so `upload` is a legal spelling of `/upload`). The reasoning is recorded at that
constant so it is not re-opened.

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
  exists only to write the bucket CORS rule. ~~Still a required prop, since a cross-origin
  editor is the default shape.~~ **Superseded on resolution:** it is now optional, guarded by
  the neither-route synth error described in the status block above.
- [rename-asset-staging-prefix.md](../rename-asset-staging-prefix.md) and
  [cdk-prefixes-duplication.md](../cdk-prefixes-duplication.md) touch the same construct.
