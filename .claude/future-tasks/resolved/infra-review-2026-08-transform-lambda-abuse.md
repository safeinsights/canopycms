---
adopters: BOTH
summary: >-
  RESOLVED (2026-08-21, epic `epic/infra-review-2026-08`) — the cost and storage halves are closed. `reservedConcurrentExecutions: 10` caps the anonymous `/assets/t/*` path (a reservation, i.e. a CAP on the account pool — it costs nothing idle, unlike provisioned concurrency); **slug is now validated against `meta.slug`** in BOTH the prod Lambda and dev-mode `serveLazyTransform`, which kills the aliasing multiplier outright — an arbitrary slug 404s and writes nothing; and an S3 lifecycle rule expires `assets/t/` derivatives at 180 days, self-healing because an expired derivative is simply regenerated on next request. Originals/meta are untouched, and a test asserts that. One correction to the filed analysis: a CloudFront miss does NOT invoke the Lambda — the behavior is an OriginGroup with **S3 primary** and the Lambda as a 403/404 failover, so routine evictions cost an S3 GET. The unbounded-crop half is deferred by decision to [transform-crop-signing.md](transform-crop-signing.md)
---
# [P2] Transform Lambda is an unauthenticated, uncapped compute and storage amplifier

Found by the 2026-08-20 three-round infrastructure review (round 1) at HEAD
`7881e489`. **CONFIRMED**, with one round-3 correction folded in below.

Successor to the mitigation that `transform-directives.ts:104-107` defers to "the
design record for the CDK PR" — that record now lives in `resolved/` with no open
row carrying the item, which is why this file exists.

## The defect

The `/assets/t/*` path is reachable by any anonymous viewer through CloudFront,
and hash32 keys are not secret for public assets — they appear in every published
page's `<img src>`.

Width and quality are allowlisted (26 × 14 values) precisely to bound
cache-stuffing. Two dimensions escape that bound:

- **Crop** is a 4-decimal-precision float rect — roughly 10^16 distinct values.
  The directive parser's own comment concedes it: "Crop remains the one
  effectively unbounded dimension … prod mitigation (rate limiting / signed
  crops) is tracked in the design record for the CDK PR."
- **Slug** is a free-form `[a-z0-9-]+` segment that `handler.ts:245-267` never
  validates against the asset's real slug — so every distinct slug string aliases
  the same asset into a new cache key.

Each unique (crop, slug) pair is a full sharp transform on a 1536MB Lambda plus
an S3 PUT of an object the bucket keeps **forever**: the design keeps everything
outside `asset-staging/` permanently, and there is no lifecycle rule for
`assets/t/`. `asset-support.ts:356-379` sets no reserved concurrency, no WAF and
no throttle.

## Failure scenario

Anyone scrapes one hash32 from the live site and loops
`GET /assets/t/w=160,c=<random rect>/<hash32>/<random-slug>.webp` with unique
rects and slugs. Every request is a CloudFront cache miss (unique path), an S3
403, a failover Lambda invocation, and a permanently stored S3 object. Nothing
rate-limits, nothing caps concurrency, nothing ever deletes the objects. An
unattended weekend is real Lambda + S3 request + storage-forever spend.

**Round 3 correction:** round 1 also claimed this could starve the CMS Lambda of
account concurrency. It cannot — the CMS function has a concurrency reservation
(reserved-10), which protects it from the transform flood. The cost and
unbounded-storage halves stand; the availability half does not.

## Fix direction

- Give the transform Lambda a small `reservedConcurrentExecutions` in
  `AssetSupport` — bounds the blast radius cheaply and is the one-line half.
- Validate `slug` against the meta record in the handler, which kills the
  aliasing multiplier outright.
- Re-open the deferred crop mitigation as a real decision: signed/HMAC'd crop
  rects, or quantize crops server-side to a coarse grid before they become a
  cache key.
- Consider an S3 lifecycle rule on `assets/t/` — these are regenerable
  derivatives, not source assets.
