# [P2] The `/assets/t/*` origin group has no room for a cross-region fallback

Raised 2026-08-24 while designing shared artifact buckets for the docs and
marketing sites. This is the Canopy-side half of that discussion — the
bucket/account decisions live in the infrastructure repo's own planning docs,
but the transform path's availability story is ours.

Closely related to [transform-crop-signing.md](transform-crop-signing.md):
the option below may retire that task entirely rather than solving it.

## The premise this rests on

Worth stating up front, because it is what makes the finding serious rather than cosmetic.

`asset-src.ts` splits delivery by format:

- **svg / pdf** are served statically from the public object `finalize` wrote
  (`assets/{hash32}/{slug}.{ext}`, via `keys.ts`'s `publicKey`). The `/assets/*` behaviour
  is S3-only — nothing under it is computed on demand.
- **raster** is served through the transform layer, **including unmodified images**, using
  the `orig` identity directive.

So `assets/t/` is not a cache of resized variants sitting beside a set of plain originals.
It is the **primary delivery path for every raster image on every page**. Anything that
takes out the transform path takes out essentially all photographic content, not just
images someone asked to be resized.

## The finding

`asset-support.ts` wires `/assets/t/*` as a CloudFront **origin group**:

- primary — the S3 asset origin
- fallback — the transform Lambda's Function URL, on `fallbackStatusCodes: [403, 404]`

That is a good design for lazy transforms, and the SPIKE RESULT in
`resolved/assets-media-system.md` confirms it works. But an origin group holds
**exactly two origins**, and both slots are spent. So the slot a cross-region S3
replica would occupy does not exist on this behavior.

The consequence, if the primary region's S3 becomes unavailable:

1. the primary origin fails,
2. CloudFront falls over to the transform Lambda,
3. the Lambda is in the same region, reads its original from the same S3, and
   writes its output to the same S3 — all unavailable.

Every transformed image fails. Replicating the derivative bucket would **not**
help, because there is no third origin to point at. `/assets/*` (static,
S3-only) can use a replica as its fallback and would keep serving; only the
transform path breaks.

Note this is a latent issue today and becomes a shared one once the docs and
marketing sites depend on the same asset store.

## Options

1. **Accept the degradation.** Wire the replica as fallback on `/assets/*`, and
   accept that `/assets/t/*` is unavailable during a regional S3 outage. Static
   assets keep serving; transformed images 404. Cheapest, and defensible — but
   it should be a recorded decision rather than something discovered mid-outage.
2. **Second-region transform Lambda** behind a Route 53 health-checked custom
   domain, so the single fallback hostname resolves to whichever region is
   healthy. Rejected in discussion as the worst of the three: two deployments of
   the same sharp-dependent Lambda to keep in sync, health-check tuning, and a
   cold standby that is never exercised until it is needed — which is when you
   find out it drifted.
3. **Materialize build-referenced transforms at build time.** See below. This is
   the direction worth costing out.

## Option 3, and why it may be the answer to more than availability

`assets/asset-url.ts` builds transform URLs at build time, so **the set of
transforms a published build references is knowable when the build runs.** If
the build materializes them:

- `/assets/t/*` for public traffic becomes **S3-only**. The Lambda leaves the
  origin group, which frees the second slot for the cross-region replica — the
  same resilience mechanism `/builds/*` and `/assets/*` already use, with no
  extra compute and nothing to keep warm.
- The **anonymous key space becomes bounded by the build manifest.** A request
  for a transform the build did not emit is a 404 that writes nothing. That is
  the whole of what `transform-crop-signing.md` is trying to achieve, and it
  achieves it without a shared secret — which sidesteps that task's stated open
  question ("where the signature is computed, given `asset-url.ts` is isomorphic
  and must not hold a secret"). No secret is needed if there is no on-demand
  anonymous generation.
- On-demand transforms still exist for the **editor**, which needs live crop
  preview. But the editor is authenticated, and the abuse vector in the signing
  doc is specifically the _anonymous_ path. Moving lazy generation to an
  authenticated behavior (its own path prefix, or the existing one gated at
  origin request) means the unbounded `crop` dimension is only reachable by
  someone already logged in.

So the answer to "how do we allowlist editor loads" is probably: don't allowlist
them, **authenticate** them. The build manifest is the allowlist for public
traffic; auth is the control for editor traffic.

### What to check before committing

- **Build cost.** Naively this is N transforms x a sharp decode per build. But
  the keys are content-addressed, so the build can skip any
  `t/{directives}/{hash32}/{slug}` that already exists in the bucket — steady
  state is only _newly referenced_ transforms. Worth measuring on a real content
  tree before assuming it is cheap.
- **The publish → build window.** An editor crop that is published but not yet
  built would reference a transform that does not exist. If Canopy publish
  already triggers a site build, this closes on its own; if not, that gap needs
  a story (fall back to the authenticated path, or block publish on build).
- **Hand-authored crops in content.** The signing doc notes adopters can
  currently write crop URLs by hand. If those are in content the build renders,
  `asset-url.ts` should see them and they get materialized — but this needs
  confirming rather than assuming, since it is the case most likely to 404.
- **Where materialized outputs live.** Either inside the build artifact
  (`builds/{site}/{sha}/assets/t/...` — exactly immutable, exactly rollback-able,
  duplicated per build) or in the shared asset bucket under the existing
  `assets/t/` keys (content-addressed dedup across builds, but a build rollback
  could reference something a reaper removed). The second is the better fit for
  content-addressed keys; it needs the reaper to respect referenced transforms.

## Fix direction

Decide between option 1 and option 3. Option 1 is a one-line CDK change plus a
recorded decision; option 3 is a real piece of work that also closes
`transform-crop-signing.md`. Do not do option 2.

If option 3 wins, sequence it _after_ the shared asset buckets exist in
the infrastructure repo, since the reaper and the bucket layout both matter to it.
