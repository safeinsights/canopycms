# Assets / Media System — Design Record + Epic Plan

Status: **RESOLVED 2026-07-22** — implemented and merged as epic PR #126 (epic phases
1–7), with CDK/deploy hardening follow-ups in PRs #128–#140 (deployment-test epic).
Kept as the durable design record, including the rejected alternative (§ Considered).
Spun-out remainders live in their own tasks: [asset-review-followups.md](../asset-review-followups.md)
(deferred review items), [docs-site-assets-wiring.md](../docs-site-assets-wiring.md)
(epic phase 8, deferred), [adopter-image-field-migration.md](../adopter-image-field-migration.md)
(phase 9, ready), [finalize-transform-decoder-mismatch.md](../finalize-transform-decoder-mismatch.md)
(live-deploy finding).

Original status: **Plan B approved 2026-07-21** (JP, after four review rounds). Implementation ran
as the `epic/assets-media-system` epic (cut from `epic/efs-cross-process-concurrency`).

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

## Decided design (Plan B)

### Storage

- **S3, not git.** Git history is append-only (every replaced image version lives
  forever) and Canopy's clone-per-branch-on-EFS architecture multiplies repo weight into
  every branch provision. (Also see § Considered — storage alternatives.)
- **New prefixes in each site's EXISTING content bucket** — versioning, SSE, RETAIN,
  us-east-2 replica + RTC replication, and origin-group failover are all inherited; the
  GitHub-OIDC deploy roles keep their `builds/*`+`previews/*`-only scope (deploy IAM and
  runtime IAM stay disjoint):

```
asset-originals/{hash32}.{ext}        private; full-fidelity originals, kept forever
asset-staging/{uuid}                  presigned-POST target; 1-day lifecycle expiry
asset-meta/{hash32}.json              private; filename, uploader, date, dims, mime
assets/t/{directives}/{hash32}/{slug} transform outputs (URL path = S3 key; no originPath)
assets/{hash32}/{slug}.{ext}          public static: sanitized SVG + PDFs only
```

- **Immutable, content-addressed, unguessable keys.** hash32 = sha-256 truncated to 32
  hex chars (128 bits). Nothing is overwritten or eagerly deleted. Branch awareness
  without git storage: a draft branch's assets are fetchable-but-unguessable
  (unlisted-link semantics) until the content referencing them publishes; publish needs
  no promotion step; rollback always resolves; identical bytes dedupe (first filename
  wins). Slugified filename stays in the key for readable/SEO-friendly URLs; the exact
  original name lives in meta + `Content-Disposition` (PDF downloads). **Unlisted ≠
  private** — accepted; confidential files don't belong here.

### Upload

- **Direct browser→S3 presigned POST** (~50 MB `content-length-range` cap, configurable,
  type conditions). Presign generation is local crypto in the CMS Lambda (no NAT needed;
  S3 management ops go through the free gateway VPC endpoint). Bytes never traverse the
  Lambda Function URL (~6 MB body cap irrelevant). This also retires two latent client
  bugs: the old JSON `data: Buffer` upload body never round-tripped, and the client's
  `FormData` branch conflicts with the CloudFront OAC `x-amz-content-sha256` prod shape.
- **No client-side shrink** (dropped by JP 2026-07-21 — it only bought upload bandwidth
  and a tighter cap; the server is canonical anyway; keeps the client simple).
- **Finalize runs synchronously in the Canopy API process** (prod: CMS Lambda; dev:
  `next dev`): magic-byte sniff (`file-type`), content hash, dimension extraction
  (lightweight lib — **sharp is NOT in the CMS Lambda**), SVG sanitization, PDF cap;
  writes originals + meta (+ `assets/` for SVG/PDF), deletes staging, returns the
  complete field value.

### Delivery — on-demand transform layer

`/assets/t/{directives}/{hash32}/{slug}.{ext}` → CloudFront behavior with **origin group
[S3 (no originPath; URL path = key, so outputs live under `assets/t/…`) → transform
Lambda on 403 AND 404]** (existing infra is OAI with `s3:List*`, so misses are 404;
configure both criteria). On miss, the Lambda reads `asset-originals/`, applies
imgix-style directives (`w=`, `f=`, `q=`, `c=x,y,w,h` normalized crop rect), strips
EXIF, **writes the output to S3 first**, then returns the bytes inline only when small
enough for the Function URL's ~6 MB buffered cap; for larger outputs and for the
transform-failure fallback it returns **302 + `Cache-Control: no-store`** to the
now-satisfiable S3 URL (the no-store matters — the OpenStax prior art documents the
cached-redirect trap). Failure fallback serves a copy written under
`assets/t/original/{hash32}/{slug}` (originals aren't otherwise URL-reachable). The
Function URL is locked to CloudFront via OAC/AWS_IAM so direct invocation can't stuff
the cache; directive allowlist (bounded width set) bounds variants. **Spike RESULT
(2026-07-22, sandbox, stack `canopy-assets-canary-spike`, torn down after): the
origin-group design is CONFIRMED** — OAC-signed S3 primary serves inside an origin
group; a miss (403 from the signed S3 origin) fails over to a Lambda Function URL
member and its response is served AND cached (second hit = `Hit from cloudfront`);
cold failover including Lambda cold start measured at 0.62 s. Residual assumption:
the spike's Lambda leg ran `AuthType: NONE` (IAM gaps below) so OAC-signed-Lambda-
inside-a-group specifically is unproven — low risk since per-origin signing provably
applies to group members (the S3 leg was signed), verify at canary deploy.

**Sandbox account deploy mechanics learned during the spike (Phase 2 must know):**
- The human `SafeInsights-DevAdmin` SSO role CANNOT: `cloudfront:CreateDistribution`,
  `cloudfront:CreateOriginAccessControl`, `iam:PutRolePolicy` (inline policies).
  It CAN: create roles with AWS-managed policy ARNs, S3 read/write, CFN operations,
  and `iam:PassRole` on the CDK bootstrap exec role.
- All resource creation therefore goes through the CDK bootstrap
  **CloudFormationExecutionRole** (`cdk-hnb659fds-cfn-exec-role-…`, AdministratorAccess)
  via `aws cloudformation deploy --role-arn …` — the same mechanism `cdk deploy` uses.
- The account's `CDKToolkit` bootstrap stack is stuck in DELETE_FAILED (since Oct 2025):
  exec role survives, publishing-role policies/staging-bucket policy partially deleted.
  The canary's transform Lambda needs CDK assets (sharp cannot be inline code), so
  Phase 2 must either repair the bootstrap or stand up a custom-qualifier bootstrap
  (e.g. `cdk bootstrap --show-template` deployed via the exec role, qualifier `canopy`)
  without touching the broken stack — JP's team may have intended to remove CDK here;
  ask before repairing the shared one. Raster images are served ONLY
via `/assets/t/*` (EXIF-strip guaranteed);
SVG/PDF static via `/assets/*`. Both behaviors go on env AND preview distributions, so
PR previews of draft branches resolve new images. This is a modernized re-design of
OpenStax `image-cdn` (../../openstax/image-cdn): S3-sourced instead of HTTP-pull, and
sync-on-miss via origin-group failover instead of the S3-website-redirect + SQS dance
(which doesn't work with OAC anyway). Prior art for hardening: AWS Serverless Image
Handler. Ships as a **per-site CDK construct** (no org-wide shared deployment — no
cross-account IAM webs; the construct is the reuse).

**Dev mode:** `withCanopy` rewrites `/assets/* → /api/canopycms/assets/*`; the local
route serves **through the store abstraction** and emulates `/assets/t/*` with
on-the-fly sharp. Two dev configurations exist and both matter: `adapter: 'local'`
(example apps; files in `.canopy-dev/assets/`; uploads proxied through the API) and
**`adapter: 's3'` under `next dev`** (docs-site until a CMS deployment exists: local
AWS credentials presign against the real sandbox bucket, `http://localhost:3000` goes
in the bucket CORS origins — this is the only way a laptop upload reaches the bucket
that CI-built PR previews serve from). The dev asset GET route depends on cookie-based
auth (Clerk / dev-plugin cookie). Identical URLs in content across modes; local
`CANOPY_BUILD=static` exports can't resolve `/assets/*` (no CloudFront locally) —
accepted.

### Content model + editor

- Structured `image` field `{ src, alt, width, height, crop? }`; optional `aspect` on
  the field definition triggers a crop step. **No variants array** — transform URLs are
  deterministic; a small `assetUrl(ref, { w })`/srcset helper is exported for host apps.
  Crop is a **URL directive** stored as a normalized rect (re-croppable anytime, no
  derived-asset bookkeeping).
- **MediaLibrary** component: manage mode in a right Drawer (BranchManager pattern,
  mounted from the EditorSidebar Settings menu, `EditorStateContext.ModalState`); picker
  mode in a Modal from ImageField and from MDXEditor via custom `ImageDialog`
  (`imagePlugin({ imageUploadHandler, ImageDialog })`, confirmed in 3.53). Grid of
  thumbnail URLs built from `media.publicBaseUrl` (the editor may be served from a CMS
  domain, not the site domain — root-relative stays only in stored content),
  cursor-paginated list over `asset-meta/` (ListObjectsV2 continuation tokens),
  client-side filename filter, `@mantine/dropzone` (pinned exactly to the installed
  Mantine core version) upload with XHR progress. Guards mirror the server: upload =
  any authenticated user (there is no finer "editor" role — Admins/Reviewers are the
  only reserved groups, and branch/path ACLs can't apply to branch-agnostic assets),
  list = any authenticated user (key enumeration accepted: unlisted ≠ private), delete
  = admin via `isAdmin` capability flags; delete removes the meta sidecar only (blobs
  immortal until a future GC worker task).
  **Superseded 2026-07-30 on two points** — see
  [asset-listing-cross-branch-exposure.md](../asset-listing-cross-branch-exposure.md):
  (1) delete is now admin **or** the recorded `uploadedBy`, still de-list-only;
  (2) the "unlisted ≠ private" tradeoff was accepted on the basis of unguessable keys,
  but the open list endpoint hands out the whole site-wide catalog, so nothing has to
  be guessed — the mitigation doesn't hold while `GET /assets` is unguarded. Still
  accepted for now (no real uploads yet), but stated explicitly in the README rather
  than left implied.
  Modal open-state follows the live
  `Editor.tsx` local-`useState` pattern (`EditorStateContext.ModalState` exists but is
  mounted nowhere — dead code; don't wire it).
- Scope: images + PDFs. No video.

### Pluggability (kept, not built)

`AssetStore` v2 contract supports direct-signed vs proxied upload modes and store-owned
variant/URL resolution, so git-backed or third-party (Cloudinary/ImageKit) adapters
remain writable later. We build only S3 + Local. No de-facto third-party store interface
was worth copying; we borrow imgix's URL-param names and Mantine/`react-easy-crop` UI
libs instead. Buying remains relevant only as a delivery-layer alternative
(ImageKit/imgix/Cloudflare over our originals) — cheap to revisit because content refs
stay vendor-neutral.

## Considered: Plan A — upload-time width ladder (REJECTED 2026-07-21)

Plan A generated a fixed width ladder (`[160, 480, 960, 1600, 2400]` ∪ per-field hints)
with sharp at finalize time, recorded a `variants` array in the field, and needed no
transform infra. Rejected in favor of Plan B because B **removes** the parts of A most
likely to age badly, at the cost of ~1–1.5 weeks extra for the transform construct:

| | Plan A (ladder) | Plan B (transform layer) — chosen |
|---|---|---|
| Extra build effort | ~1 day inside the pipeline | ~1–1.5 weeks: Lambda + construct + directives + wiring |
| CMS Lambda | +sharp (~35 MB), ≥2048 MB, 5–15 s heavy uploads | stays lean; finalize is milliseconds |
| Known-size holes / avatars | config rungs + per-field `widths` hint machinery | any size, always |
| Cropping | derived assets; re-crop = re-upload | a URL directive; re-crop = edit a rect |
| New runtime components | none | one Lambda/site; ~½ s first-hit per variant; transform-failure→serve-original fallback |
| Ongoing | worker back-fill jobs on ladder/quality changes | none — pipeline version changes cache keys |
| Future sites | inherit ladder via construct | inherit transforms via construct (strictly more capable) |

Also considered and rejected earlier in the design rounds:

- **Git-backed storage** (branch clones carry images): repo-growth ratchet + clone-per-
  branch multiplication; kept possible as a future adapter for tiny adopters.
- **Git LFS**: touches every moving part (EFS bot pushes, CI, adopter setup, bandwidth
  quotas) for modest volume.
- **Per-env or org-wide asset buckets**: per-env breaks cross-env reference resolution
  or adds replication lag; org-wide adds cross-account IAM + coupling for a library-
  sharing benefit we don't need yet. Existing-bucket prefixes won.
- **Async processing on the CmsWorker**: the final URL is the hash of processed bytes,
  so the editor waits either way; async only added pending-state UX and a second dev
  code path.
- **Client-side shrink**: dropped; see Upload.
- **Buying the core** (Cloudinary et al.): entangled with Canopy auth/branch model; the
  no-NAT CMS Lambda can't reach third-party management APIs; content-URL lock-in.

## Epic breakdown (PR sequence)

1. Store contract v2 + S3/Local stores + `media` config consumption (new `assets/` module)
2. HTTP plumbing: binary/stream `CanopyResponse` variant + raw request body + Next adapter support (prereq for stream/dev serving and proxied uploads)
3. Asset API (presign/finalize/list/delete/stream) + finalize pipeline + client regen + guard change
4. Transform engine (directive parser + sharp module) + dev-mode `/assets/t/*` emulation + `assetUrl` helper
5. Structured `image` field (schema + AI serialization)
6. Editor: ImageField + MediaLibrary (Drawer/picker) + MDX wiring + crop step
7. CDK: origin-group OAC spike FIRST, then AssetSupport construct (BYO-bucket + standalone) + transform Lambda (Docker/image bundling for sharp) + behavior helpers + `CanopyCmsService` fix (S3 gateway endpoint + SG egress + IAM — the construct as built cannot reach S3 at all)
8. docs-site-proto wiring (separate repo): infra + config + **fix `update-distribution.ts` to flip OriginPath only on build origins** (today it stamps every origin — first deploy after adding the asset origin would 404 all assets)
9. Adopter codemods + `public/` migration job
10. Docs + bookkeeping

Success criteria (hard gates): dev e2e — upload via MediaManager and MDX, pick-from-library
from both entry points, paginated library, guard-hidden controls, structured value in the
content file, emulated transforms render in preview and post-publish, 40 MB original
accepted, SVG-script sanitized, PDF real-filename download, crop rect round-trips.
Prod-shape e2e (sandbox) — scope depends on the open B1 decision below; at minimum:
presigned upload against the real sandbox bucket (from dev-mode-with-S3 or a deployed
editor), first `/assets/t/…` hit transforms, second is a cache hit with immutable
headers; transform-failure fallback; PR preview renders a draft branch's new image;
draft image unreachable from published pages until publish; originPath flip doesn't
disturb assets.

## Adversarial review amendments (2026-07-21)

A heavy adversarial review of the approved plan against the real code produced these
corrections, all folded into the sections above:

- **B1 (open decision, gates Phase 2 verification):** no CMS/editor Lambda is deployed
  anywhere — docs-site runs the editor only under `next dev`, and `CanopyCmsService`
  as built has a PRIVATE_ISOLATED VPC with no S3 endpoint and NFS-only SG egress.
  Either (a) re-scope prod-shape e2e to dev-mode-with-S3 + direct CloudFront checks, or
  (b) add a full sandbox CMS-service deployment to the epic. **JP to decide.**
- **B2:** `update-distribution.ts` stamps OriginPath onto every origin → PR 8 fix.
- **B3:** dev-mode dual configuration made explicit (local vs S3-in-dev); dev route
  serves through the store abstraction.
- **M1:** transform Lambda writes-to-S3-first; inline bytes only under the ~6 MB
  Function URL cap; 302+no-store for large/fallback; fallback copy under
  `assets/t/original/`.
- **M2:** JSON-only HTTP pipeline → new PR 2 (binary responses, raw bodies).
- **M3:** `EditorStateContext.ModalState` is unmounted dead code → use `Editor.tsx`
  local-useState pattern.
- **M4:** editor thumbnails via `media.publicBaseUrl` (editor origin ≠ site origin).
- **M5:** guard semantics stated exactly (authenticated / authenticated / admin).
- **M6:** `file-type` cannot detect SVG (text format) — explicit XML/root-element check
  before the sanitizer; sniff-undefined is never pass-through.
- **M7:** `asset-cache/` prefix dropped; outputs under `assets/t/…` (URL = key).
- Minor: meta writes use S3 conditional `If-None-Match: *` (LocalAssetStore gets a `wx`
  equivalent for parity); `content-disposition` package against header injection;
  `image-size` orientation 5–8 width/height swap; SVG sanitizer needs a DOM shim —
  server-only module; `@mantine/dropzone` pinned exactly to installed core (7.17.8);
  media config discriminator is `adapter` (not `kind`); sharp in the transform Lambda
  requires Docker/image bundling; deploy `/*` invalidation needlessly evicts transform
  cache (accepted); `FormRenderer` image case goes in the switch (~line 224), not the
  custom-renderer branch at line 192.
