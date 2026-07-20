# Future Task: Assets / Media System (design + plan)

Status: **design agreed in principle 2026-07-19** (JP + Claude session). Two sub-decisions
left open with recommendations below (§ Open decision A, § Open decision B). Everything
else in this doc is settled.

## Problem

CanopyCMS has an asset _skeleton_ that was built early and never connected:

- `asset-store.ts`: `AssetStore` interface + `LocalAssetStore` (implemented, unit-tested,
  **never instantiated** by any non-test code).
- `api/assets.ts`: `ASSET_ROUTES` (list/upload/delete) registered in the router but every
  call returns `501 Asset store not configured` because nothing ever passes
  `options.assetStore` into the handler.
- `config/schemas/media.ts` + `MediaConfig` types (local/s3/lfs): validated, **never consumed**.
- `image` field type: exists in `primitiveFieldTypes` and in AI markdown serialization, but
  `FormRenderer` has no case for it → renders "Unsupported field: image".
- MDXEditor toolbar has `<InsertImage />` but `imagePlugin()` is called with no
  `imageUploadHandler` → URL-paste only.
- Client SDK bug: `client.assets.delete()` never sends the required `?key=` param.
- Upload guard is `privileged` (Admin/Reviewer) — **editors cannot upload**, which is
  backwards for the actual use case.

Meanwhile both adopters (`../docs-site-proto`, `../website`) hand-manage images in
`public/`, referenced by raw string paths typed into plain-text fields, baked into per-SHA
static build artifacts. The website ships ~14 MB of unoptimized images (several
1.5–3.3 MB files). Editors cannot add an image without a developer committing the file.
More static sites are coming.

## Decisions (settled with JP, 2026-07-19)

1. **Storage: S3, not git.** Repo-growth worry is legitimate: git history is append-only
   (every replaced image version lives forever), and Canopy's clone-per-branch-on-EFS
   architecture multiplies repo weight into every branch provision.
2. **Branch awareness via immutable, content-addressed, unguessable keys.** Key =
   sha-256 of the bytes. Never overwrite, never eagerly delete. A draft branch's assets
   are fetchable-but-unguessable (unlisted-link semantics) until the content referencing
   them is published. Publish needs **no asset promotion step**; rollback always resolves
   because old keys never change; identical uploads dedupe for free.
   _Caveat (accepted): unlisted ≠ private. Fine for public-site media; not for
   confidential documents._
3. **Direct browser→S3 upload via presigned POST.** The Canopy API authenticates,
   checks ACLs, and signs (signing is local crypto — no network). Bytes never traverse the
   Lambda Function URL, so its ~6 MB body cap is irrelevant. The no-NAT prod Lambda
   reaches S3 for list/head/get/delete via a free S3 **gateway VPC endpoint**.
4. **One shared asset bucket per site across all environments** (dev/staging/prod
   accounts + previews), fronted by an `/assets/*` behavior on each environment's
   CloudFront distribution via cross-account OAC. References resolve identically
   everywhere; no replication/sync problem.
5. **Asset types v1: images + PDFs/documents.** Assume users upload stupidly large
   files; shrink or gracefully handle them (client-side downscale before upload +
   server-side enforcement). PDFs pass through unprocessed with a size cap. No video
   (would force different storage economics; revisit if needed).
6. **Structured image field value**: `{ src, alt, width, height, variants? }` — alt
   enforced at the field, intrinsic dimensions prevent layout shift, srcset data flows to
   static builds with no lookups. Both adopters' `imageSrc`/`imageAlt` string pairs get
   migrated (schema + content codemod).
7. **Editor UX v1: image field + MDX upload + media manager** (browse/search/pick/
   delete/upload library view).
8. **Build, don't buy.** Home-grown on the existing `AssetStore` seam. The OpenStax
   `image-cdn` (../../openstax/image-cdn) is a lazy pull-based _optimizer_ (no upload
   flow), frozen on EOL Node 16 and coupled to OpenStax accounts — relevant only as a
   possible future delivery layer (see Open decision B), not for the upload/storage gap.

## Architecture

### Bucket layout

```
staging/{uuid}                     # presigned-POST target; lifecycle-expired after 1 day
originals/{sha256}.{ext}           # canonical uploaded bytes (post client-shrink), kept forever
assets/{sha256}/w{width}.v{n}.webp # processed variants (n = pipeline version)
assets/{sha256}/orig.v{n}.{ext}    # normalized full-size (capped) rendition; PDFs/SVGs live here
meta/{sha256}.json                 # sidecar: filename, uploader, date, dims, variants, mime
```

- CloudFront OAC exposes only `assets/*`. `staging/`, `originals/`, `meta/` are private.
- Variant keys include original-hash + width + pipeline version → immutable in practice
  (bump `v` when the sharp pipeline changes), safe with 1-year `immutable` caching.
- Media-manager listing reads `meta/` sidecars (paginated ListObjectsV2 + parallel GETs).

### Upload flow

1. Editor picks a file. **Client-side pass** (popular lib, e.g. `browser-image-compression`):
   read dimensions, downscale to cap, re-encode. Handles "stupidly large" phone photos
   cheaply and keeps the direct upload small.
2. `POST /assets/presign` → auth + ACL check → presigned POST to `staging/{uuid}` with
   `content-length-range` and content-type conditions.
3. Browser uploads directly to S3.
4. `POST /assets/finalize` → server fetches staged object (gateway endpoint), sniffs real
   type (magic bytes, e.g. `file-type`), hashes, runs the **server-side sharp pass**
   (see Open decision A): EXIF-strip (privacy) + orientation bake, cap dimensions,
   re-encode webp, emit variants (see Open decision B), sanitize SVG, write
   `originals/`, `assets/`, `meta/`, delete staging object.
5. Response returns the complete structured field value
   `{ src, width, height, variants }`; editor fills the field / MDX insert immediately.

Client-side processing is UX, not security: the server re-validates and re-encodes
regardless (it must read the bytes anyway to compute the content hash).

### Serving / URLs

- Field `src` is root-relative: `/assets/{hash}/w1600.v1.webp`.
- **Prod (static export)**: CloudFront `/assets/*` behavior → shared asset bucket (OAC),
  `Cache-Control: public, max-age=31536000, immutable`.
- **Dev mode**: `withCanopy` adds a Next rewrite `/assets/* → /api/canopycms/assets/*`;
  a GET route streams from the local store. Same URLs in content in both modes.
- Optional `media.publicBaseUrl` config for adopters serving assets from another domain.

### Adapters and config

- `S3AssetStore` (new) + reworked `LocalAssetStore` (dev; files under `.canopy-dev/assets/`)
  implementing the same v2 `AssetStore` contract (presign-or-direct upload, finalize,
  list, delete, stream). `media` config finally consumed: context factories instantiate
  the store from `media: { kind: 's3', bucket, region, publicBaseUrl? }` (prod) or
  default local (dev). LFS stays a config literal — not implemented, likely never.

### Permissions

- Upload: any authenticated **editor** (change from current `privileged` guard).
- Delete: **admin** only. Delete removes the `meta/` sidecar (hides from the manager);
  blobs stay (immutability/rollback safety). A later GC worker task can hard-delete
  blobs unreferenced across all branches. Also resolve the listAssets enumeration note
  from the 2026-04 baseline review (any authenticated user can list; acceptable?).

### Infra (canopycms-cdk)

- New `AssetBucket` construct: bucket + CORS (editor origins for presigned POST) +
  `staging/` lifecycle rule + OAC grants (+ optional replica, matching docs-site
  failover pattern).
- Distribution helper: add `/assets/*` behavior (long-TTL cache policy) to
  `SecureDistribution`-style env + preview distributions, cross-account OAC.
- IAM: CMS Lambda role gets get/put/list/delete on the bucket; confirm S3 gateway
  endpoint exists in the VPC. Decide at implementation which account hosts the shared
  bucket in official multi-account mode (likely the build/artifacts account).

## Open decision A — where the server-side sharp pass runs

"Client-only" is not actually on the table: the server must read the bytes anyway to
content-hash, sniff, and sanitize; running sharp there is marginal. The real choice:

| | **A1. Sync, in the Canopy API (recommended)** | **A2. Async, CmsWorker task** |
|---|---|---|
| UX | Upload → ready in one round trip (~2–6 s worst case for a 25 MB staged file). Field value complete at insert. | Upload becomes "pending"; media manager + image field + MDX insert all need progress/poll/failure states. |
| Interaction w/ content-addressing | Final key = hash of **processed** bytes → reference can't exist until processing completes. Sync fits naturally. | The editor must wait for processing anyway to learn the URL — async moves compute but buys no latency for the user. |
| Interaction w/ structured field | Dimensions + variants known at insert time. | Placeholder-then-patch flow; ugly. |
| Dev mode | Same code path runs inline in the dev server. One implementation. | Dev has no worker running → needs an inline fallback anyway → two code paths. |
| Prod footprint | sharp (~35 MB unzipped native dep) joins the CMS Lambda bundle (250 MB limit — fine); bump memory to ≥1024 MB. | Lambda stays lean; EC2 t4g.nano does the work (it's a spot nano — big ladders would be slow there, ironically). |
| Failure modes | Function URL timeout is generous (up to 15 min); presign size cap bounds work. | Queue retries for free; but partial-state cleanup spans two services. |

**Recommendation: A1**, with the worker reserved for what async is genuinely good at:
bulk jobs — back-filling variants when the ladder/pipeline version changes, GC, and the
one-time migration of existing `public/` images.

## Open decision B — delivery efficiency (variants)

Context that matters: static export (no runtime `next/image`), structured field carries
srcset data, originals are kept forever (so any option can be adopted later without
re-uploading), and **more static sites are coming**.

| | **B1. Pre-generate width ladder at upload (recommended)** | **B2. Single normalized file for v1** | **B3. On-demand transform CDN (image-cdn-style)** |
|---|---|---|---|
| What ships | Config-driven ladder (default `[480, 960, 1600, 2400]`, never upscaled) per image, webp, all immutable keys. Field records the actually-generated set; sites render `<img srcset>`. | One capped-width webp per upload. | Lazy sharp Lambda + S3 cache behind CloudFront; arbitrary `w=`/`f=` directives; modernized fork of OpenStax image-cdn or new build. |
| Visitor efficiency | Real responsive delivery; mobile pulls ~480–960 px. | Good (capped ~1600 px webp ≈ 150–300 KB) but mobile over-fetches. | Best/most flexible (exact sizes, future art direction). |
| Infra | None beyond the bucket. Scales to N sites with zero coordination — each site self-contained via the CDK construct. | None. | New always-on (though lazy/near-zero-idle) stack to own; port from EOL Node 16 + OpenStax account/DNS coupling, or greenfield. One shared org stack **could** serve all future sites — this is where B3 gets attractive as site count grows. |
| Cost | Storage +~60–100 % of normalized size — trivial at this volume. Adding a new width later = worker reprocess job. | Cheapest. | Engineering cost high now; compute amortizes across sites later. |
| Static-export fit | srcset known at build time from field value. Perfect. | Trivial. | Variant URLs are deterministic patterns → also build-friendly, and simplifies the field (no variants array) — but adds runtime infra dependency to every page load's images. |

**Recommendation: B1 now.** Since sharp already runs at upload (decision A1), the ladder
is marginal work, needs zero new infra, and answers "we want efficient" immediately.
Revisit **B3 as a shared org-wide service** when the number of sites or design needs
(arbitrary sizes, crops) justify owning transform infra — content-addressed `originals/`
make that migration purely additive (new URL scheme; existing assets stay valid).

## Security notes

- Sniff real content type from magic bytes; never trust the client's MIME.
- **SVG**: both sites use SVG logos heavily → support SVG, but sanitize at upload
  (scripts/event handlers/foreignObject stripped) — pick the sanitizer lib at
  implementation. Consider a restrictive `Content-Security-Policy: sandbox`-style
  response header on `/assets/*` as defense in depth.
- Strip EXIF (GPS!) via sharp; bake orientation before stripping.
- Presign conditions enforce size + type caps server-side (client limits are advisory).
- Hash-keyed paths eliminate traversal/collision concerns; no user-controlled key names.
- Unguessable ≠ private: document that confidential files don't belong here.

## Known bugs to fix in passing

- `api/client.ts` `assets.delete()` never sends `?key=` (always 400s).
- Upload guard `privileged` → change to editor-accessible.
- `MediaConfig.publicBaseUrl` TS/Zod drift (already on the baseline-review deferred list).

## Phasing

**Phase 1 — package core (canopycms)**
AssetStore v2 contract + `S3AssetStore` + local store rework; consume `media` config in
context factories; presign/finalize/list/delete/stream endpoints (+ client SDK regen,
fix delete bug, permissions change); sharp pipeline (normalize, EXIF strip, ladder,
SVG sanitize, PDF pass-through); structured `image` field (Zod + FormRenderer
`ImageField`); media manager UI; MDX `imageUploadHandler`; AI serialization update for
the structured value; end-to-end tests (local-store parity + mocked S3).

**Phase 2 — infra (canopycms-cdk + docs-site-proto)**
`AssetBucket` construct (CORS, lifecycle, OAC, optional replica); `/assets/*` behavior on
env + preview distributions; IAM + gateway endpoint; wire docs-site-proto config
(`media: s3`) and deploy. Website inherits when its Phase-6 infra port lands (dev-mode
local store works meanwhile).

**Phase 3 — adoption + migration**
Schema/content codemods in both sites (`imageSrc`/`imageAlt` → image field); one-time
migration of existing `public/` images into the asset system (worker bulk job) —
including optimizing the website's 1.5–3.3 MB offenders; README media section replaces
"Not Yet Implemented"; docs (ARCHITECTURE/DEVELOPING) updates.
