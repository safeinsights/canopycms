# [P2] Crop is still an unbounded cache-key dimension on the anonymous transform path

Split out of [resolved/infra-review-2026-08-transform-lambda-abuse.md](resolved/infra-review-2026-08-transform-lambda-abuse.md)
(2026-08-21). That task closed the cheap and unambiguous halves; this is the
half that needs a real design decision, and **JP asked for it as its own
session immediately after the infra-review epic**.

## What is already done

- `reservedConcurrentExecutions: 10` on the transform Lambda — a cap on the
  account concurrency pool, so a flood cannot scale without bound.
- **Slug validated against `meta.slug`** in both the prod Lambda
  (`canopycms-cdk/lambda/asset-transform/handler.ts`) and dev-mode
  `serveLazyTransform` (`api/assets.ts`). That killed the *aliasing* multiplier
  outright: an arbitrary slug is now a 404 that writes nothing.
- S3 lifecycle expiry (180 days) on `assets/t/`, so derivatives can no longer
  accumulate forever. Originals under `asset-originals/` are untouched.

Together these bound the *cost*. They do not bound the *key space*.

## What remains

`crop` is `c=<x>:<y>:<w>:<h>`, four floats at `CROP_PRECISION = 4`
(`assets/transform-directives.ts`) — roughly **10^16** distinct rects for one
asset. Width and quality are allowlisted (26 x 14) precisely to bound this;
crop was left unbounded because editor rects need float precision, and the
parser's own comment concedes it.

`hash32` is not secret: it is in every published page's `<img src>`. So an
anonymous caller can still mint unbounded *distinct* cache keys for a real
asset. What that now costs is bounded (≤10 concurrent transforms, objects
expire at 180 days) rather than unbounded, but it is still: a permanent
CloudFront cache-miss stream, real Lambda spend, and S3 PUT + storage churn for
objects nobody will ever request twice.

## The options, and the tradeoff

1. **HMAC-signed crop directives.** Only Canopy-generated crop URLs are
   honoured. Actually bounds it. Costs: a shared secret between the site build
   and the transform Lambda (the URLs are built at build time by
   `assets/asset-url.ts`, which is isomorphic and client-reachable — so the
   signing has to happen somewhere that can hold a secret, which is the real
   design question); and it breaks any hand-authored crop in content, which
   adopters can currently write.
2. **Server-side quantization.** Lower `CROP_PRECISION` from 4 to 3: 10^16 →
   10^12, one constant, invisible to callers (0.1% of a dimension ≈ 4px on a
   4096px image). 2 decimals would give 10^8 but at 1% granularity, which a
   careful editor crop would notice. Cheap, partial, and composes with (1).
   Safe for already-published URLs: the parser still *accepts* 4 decimals and
   quantizes, and the handler already redirects a non-canonical path to the
   canonical key.
3. **Accept it**, on the grounds that the cost is now capped. Record the
   decision so a later review does not re-report it as live.

Note (2) is not an alternative to (1) so much as a cheap down-payment on it.

## Fix direction

Decide between signing and quantization first — it is a product decision about
whether hand-authored crops in content are supported. If signing wins, the open
question to answer before coding is **where the signature is computed**, given
that `asset-url.ts` is isomorphic and must not hold a secret.
