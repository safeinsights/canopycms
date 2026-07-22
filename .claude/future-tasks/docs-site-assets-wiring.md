# Future Task: Wire the assets system into docs-site-proto (deferred)

Status: **deferred by JP 2026-07-22** — the docs-site-proto sandbox deploy is currently
serving as the real deployment (production deploy not done yet), so its stacks, bucket,
and distributions must not be touched until production lands and the team is using it.

## What this task does (when unblocked)

Apply the assets epic's Phase 2 wiring to docs-site-proto (this was PR 8 of
`epic/assets-media-system` before re-scoping; design record:
[assets-media-system.md](assets-media-system.md)):

1. **AssetSupport (BYO-bucket mode)** onto `infrastructure/lib/artifacts-stack.ts`:
   the four `asset*` prefixes' lifecycle rules, bucket CORS for editor origins
   (including `http://localhost:3000` while the editor runs only under `next dev`),
   replication scope for the new prefixes, CMS-Lambda IAM scoped to the prefixes.
2. **Behaviors** on `secure-distribution.ts` AND `preview-stack.ts`: second
   no-originPath origin for the same bucket + `/assets/*` (static) and `/assets/t/*`
   (origin group [S3 → transform Lambda], failover on 403+404) behaviors. Note the
   existing infra uses OAI; the AssetSupport construct uses OAC — verified compatible
   choices per the canary, but pick one deliberately here.
3. **CRITICAL bug fix that MUST land in the same change**:
   `infrastructure/scripts/lib/aws.ts` `updateDistributionOriginPath` stamps
   `/builds/{sha}` onto EVERY origin. The first deploy after adding a no-originPath
   asset origin would rewrite it and 404 all assets. Fix it to match build origins by
   Id before adding the asset origin. (Adversarial review finding B2.)
4. `media: { adapter: 's3', bucket, region }` in `canopycms.config.ts`.
5. Verification: presigned upload from the dev editor against the real bucket; PR
   preview of a draft branch renders a newly uploaded image; build promotion
   (originPath flip) provably doesn't disturb `/assets/*`; transform first-hit/cache-hit
   through both env and preview distributions.

## Prerequisites

- docs-site-proto production deploy complete; team migrated onto it.
- Assets canary verification complete (proves the construct + transform Lambda; done
  or in progress under the epic — see `canopy-assets-canary` stacks in the sandbox).
- Schema/content codemod for docs-site (epic PR 9) can land EARLIER as a no-infra
  change: structured image fields accept existing `/images/...` paths as `src`, so the
  codemod is serving-neutral until this task migrates files into the asset system.
