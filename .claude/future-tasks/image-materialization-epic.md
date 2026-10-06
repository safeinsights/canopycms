# [P1] Epic: the public image path serves only what a build referenced

Integration branch `int-image-materialization`, cut from `int-202610-a`. Every phase PR
targets it, and it is rebased onto `main` once `int-202610-a` lands. Supersedes
[transform-crop-signing.md](transform-crop-signing.md) and
[transform-path-regional-resilience.md](transform-path-regional-resilience.md). Both close
when this epic's PR merges.

## Problem

`/assets/t/{directives}/{hash32}/{slug}.{ext}` is anonymous, and `hash32` is public.

- **Compute is unbounded.** The parser accepts directives in any order and crop floats
  with any number of decimals (`transform-directives.ts`, `UNIT_FLOAT_RE` and
  `parseDirectivesString`). A non-canonical spelling is not redirected, so every spelling
  is a fresh transform, in the Lambda handler and in dev `serveLazyTransform` alike.
- **Storage is bounded only by the canonical key.** Output is written under the canonical
  key at `CROP_PRECISION = 4`, which still allows about 10^16 crops per asset.
- **What already caps the cost:** reserved concurrency 10, the slug pinned to
  `meta.slug`, and the 180-day `assets/t/` expiry.

Four related defects:

- **Image paths have no regional failover.**
  - `/assets/*` uses the primary bucket only, and its second origin slot sits unused.
  - `/assets/t/*` spends its second slot on the transform Lambda, which lives in the same
    region.
  - An adopter that replicates `assets/` cross-region cannot serve the replica.
- **Crops never render on a published site.** `AssetRef` is `{ src }`, and `assetUrl`
  ignores the crop unless the caller passes `opts.crop`. The README examples don't pass
  it, so editors see a crop that the site never shows.
- **Editor previews use the anonymous path in prod:** `w=320` plus the crop, `w=160`
  thumbnails, and `orig` for the crop source.
- **Widths are multiples of 160 in [160, 4096], and uploads over 16.7MP are rejected
  outright** (`MAX_INPUT_PIXELS`). Small avatars and large banners both suffer.

## Design (decided 2026-10-06; Fable plan review folded in)

1. **The public `/assets/*` and `/assets/t/*` are S3-only.** Each is an origin group of
   the primary bucket plus an optional replica, failing over on 5xx. A miss returns 403
   or 404, and nothing is computed.
2. **Derivatives are materialized before a build is released.**
   - A collector scans the build output and writes `canopy-asset-refs.json` into it.
   - A CLI materializer (`S3AssetStore` + `applyTransform`, no Lambda) generates only
     the keys that are missing.
   - The adopter's release gate confirms every referenced key exists, in the replica too.
3. **Editors and live preview use the authenticated route** (`/api/canopycms/assets/raw/...`).
4. **Width policy depends on the path.**
   - The authenticated route, the collector and the materializer accept any integer in
     [1, 8192].
   - The opt-in lazy public Lambda keeps an allowlist, with small rungs added.
   - `q` stays allowlisted everywhere.
5. **Materialized derivatives are kept forever.** The lazy opt-in keeps its expiry.

**Rejected: HMAC signing.** Widths are chosen by site code at render time, so they can't
be pre-signed. Signing also needs a secret wherever URLs are minted, including the browser
during preview, and it does nothing for failover.

**Rejected: collecting from content.** Widths live in site code, not in content, and build
output is the only place a final URL exists. That creates an adopter contract: every
`/assets/t/` URL a site can request must appear as text in its build output.

## Phases

| # | PR scope | Status |
|---|---|---|
| 0 | Hardening that stands alone (below) | open |
| 1 | Authenticated route carries editor and preview traffic | open |
| 2 | `collect-asset-refs` and `materialize-assets` CLIs | open |
| 3 | `AssetSupport` S3-only public path, replica, lazy opt-in, width policy, `MAX_INPUT_PIXELS` | open |
| 4 | Adopter requests entry (sent to the adopter repo, not landed here) | open |
| 5 | Docs, bookkeeping, and the final Fable full-diff review | open |

### Phase 0: hardening that stands alone (widths unchanged)

- **Non-canonical directive strings.**
  - The Lambda answers with a cacheable 301 to the canonical path, before any meta read.
  - `serveLazyTransform` serves the canonical bytes without redirecting, so an
    authenticated request is never bounced onto the public path.
- **Crops render.** `AssetRef` gains `crop?`, and `assetUrl`/`assetSrcSet` apply it by
  default (`opts.crop` still overrides). Fix the README examples.
- **One crop-precision constant.** `editor/media/crop-math.ts` shares `roundCropRect`
  instead of keeping its own.
- **Stale comment.** The crop comment in `transform-directives.ts` points at a design
  record that no longer exists; point it here.

### Phase 1: the authenticated route

- **`rawAssetHandler` behaviour.**
  - If the derivative already exists, 302 to the public URL. That costs one HEAD and no
    body through the Lambda. It matters because the CMS Lambda is concurrency-capped and
    uncached, and preview re-renders every image on the page.
  - If the body is over about 4 MiB, 302 to a presigned S3 GET. The CMS Function URL is
    buffered, with a cap of about 6 MiB; the transform Lambda's `INLINE_BODY_LIMIT_BYTES`
    branch is the model to copy.
  - Transform only on a miss.
- **Editor.** `AssetContext` always uses the authenticated prefix, built from the origin
  plus `basePath`. That covers previews, thumbnails and the crop source, and it resolves
  [editor-asset-mount-topology.md](editor-asset-mount-topology.md).
- **Preview override.**
  - The editor sends the authenticated prefix in the draft message.
  - A module owned by the preview bridge stores it, and `assetUrl` reads it through an
    injected getter that does nothing on the server.
  - It applies only to `/assets/t/` srcs, and it wins over `opts.baseUrl`.
  - Check how `attachTo`'s static-export preview route (`previewPrefix`) carries this.
- **Sharp is now load-bearing for editor images.** Fold in
  [admin-status-image-processing-availability.md](admin-status-image-processing-availability.md),
  and add an e2e that loads a fresh crop through the authenticated route.

### Phase 2: collect and materialize

- **`collect-asset-refs <outDir>`.**
  - Scans html, txt, json and js output for transform URLs.
  - Fails on any non-canonical URL.
  - Records which output file and page route each URL came from.
  - Writes the refs file into `outDir` before the adopter's manifest step, so the
    manifest covers it.
- **`materialize-assets --refs <file>`.**
  - Existence pass first: parallel HEADs, or one paginated `ListObjectsV2` over
    `assets/t/` when the refs are many.
  - Transforms only the missing keys, and loads sharp only if any are missing.
  - Reports `existed`, `created` or `failed` for each key.
  - Retries transient S3 errors with backoff.
  - Rerunning it is idempotent.
  - A content error gets no retry (a referenced asset was deleted, or a decode or 413
    failure). The report names the page so it can be fixed.
  - It exits non-zero on any failure. `--allow-failures` (off by default) lets a release
    proceed, loudly, with only those URLs missing.
  - IAM: Get on `asset-originals/` and `asset-meta/`, Put on `assets/t/`.

### Phase 3: the CDK public path and width policy

- **`AssetSupport` default, materialized mode.**
  - Both behaviours become S3 primary plus an optional `replicaBucket`, failing over on
    500, 502, 503 and 504, under `CACHING_OPTIMIZED`.
  - No transform Function URL or OAC is created.
  - No `assets/t/` expiry.
- **`lazyPublicTransforms: true` keeps today's origin group.**
  - It keeps the width allowlist plus 32, 48, 64, 96 and 128.
  - It keeps the canonical 301, reserved concurrency and the 180-day expiry.
  - On a BYO bucket it is refused unless `transformOutputRetention` is passed explicitly,
    because a shared prefix cannot hold both forever-kept and anonymous objects.
- **The width policy becomes a parser option** (`allowlist` | `any`).
- **Raise `MAX_INPUT_PIXELS` to about 50MP (8192×6144)** only after a measured memory
  gate.
  - Measure in both the transform Lambda and the CMS Lambda.
  - Include a 60-frame animated WebP at the cap.
  - Record the numbers in the PR.
  - Finalize and transform keep sharing the one constant.

### Phase 4: what an adopter with a promote pipeline needs

This is written up as an adopter request and kept generic here.

- **Build step.** The build runs `collect-asset-refs` before writing its manifest.
- **Release order.** promote → materialize → the existing "is it published" check
  extended to every referenced key (this is the release gate) → the existing replication
  wait extended to those keys → flip.
  - Existing derivatives replicated long ago and return COMPLETED on the first HEAD.
  - New ones ride the same replication window the build's own files already wait on.
- **Preview deploys** run collect and materialize too, but skip the replica wait.
  - Derivatives are content-addressed and shared, so a preview's work is reused when the
    PR merges.
  - The cost: PR builds can add objects to the prefix production serves. That is storage
    only, never a wrong image.
- **Infrastructure.** Drop any `assets/t/` expiry rule, pass the replica to
  `AssetSupport`, and give the materializer a role with the grants above.
- Sequence this with [adopter-image-field-migration.md](adopter-image-field-migration.md).

## New adopter touchpoints (approved as a set, 2026-10-06)

| Touchpoint | Where it lands |
|---|---|
| `collect-asset-refs` build step; the refs file ships in the build output | adopter CI |
| `materialize-assets` step, plus a role that can run it | adopter CI and infra |
| `replicaBucket` and `lazyPublicTransforms` props on `AssetSupport` | adopter CDK |
| Every `/assets/t/` URL appears as text in the build output | adopter site code |
| The CMS image must load sharp. It already does via `withCanopy`'s tracing; this makes it load-bearing | adopter image build |

## Chip protocol

- This epic's manager session issues one chip per phase.
- Phases 0 to 3 run in order, and each chip stacks on the merged previous phase.
- A chip runs `/review-rounds` and `/claim-check`, messages the manager `READY #<n>`, and
  stops.
- On `GO #<n>` it merges the latest `int-image-materialization` once, re-runs every gate,
  pushes, and reports.
- The manager merges into the integration branch.

## Verification gates

- **Red-before-green unit tests**, each checked by breaking it and re-running:
  - the canonical 301, and canonical bytes on the authenticated route;
  - `assetUrl` applying `ref.crop`;
  - both width-policy modes;
  - the raw route's two 302 branches;
  - the collector failing on non-canonical URLs;
  - materializer idempotency.
- **A real-export collector test.** Statically export a fixture app, record every URL
  `assetUrl` emits through a test-only hook, and assert collected == emitted. A
  hand-written HTML fixture would only test the regex.
- **e2e.**
  - A preview page with 20 or more images shows no 429 or 502.
  - A fresh editor crop loads through the authenticated route.
  - A logged-out fetch of an unmaterialized URL returns 403 or 404 and writes nothing.
- **CDK synth.**
  - Materialized mode: S3-only groups with the replica, no Function URL, no expiry.
  - Lazy mode: today's shape plus the expiry.
  - BYO plus lazy is refused.
- **Sandbox (deploy-test).**
  - A materialized key serves.
  - An unreferenced key is a miss and writes nothing.
  - Denying the primary fails over to the replica.

## Follow-ups to file when the epic closes

- A reference-aware reaper for `assets/t/`, keyed on the refs files of every build inside
  the rollback window.
  - Access logs are a weak signal. CloudFront caches derivatives for up to a year, so S3
    logs undercount, and S3 has no last-access time.
- A per-distribution CloudFront 4xx-rate alarm on `/assets/t/*`, as the runtime backstop
  for refs the collector misses.
- An allowlist-gated lazy mode (refuse keys not in a refs manifest), as the fallback if
  adopters can't add the pipeline steps.
