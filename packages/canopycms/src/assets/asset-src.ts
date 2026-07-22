/**
 * Compute the root-relative public URL for an asset's meta. Shared helper -
 * both the API layer (list/finalize responses) and later PRs (structured
 * image field, MediaLibrary, `assetUrl()`) build URLs through this so the
 * URL shape is defined in exactly one place.
 *
 * svg/pdf: served statically from the public object finalize wrote
 * (`assets/{hash32}/{slug}.{ext}`, via keys.ts's `publicKey`).
 *
 * raster: served through the transform layer using the `orig` (identity)
 * directive. The transform engine itself is PR 4's job, but the URL shape is
 * decided now (rather than switching every raster URL over once transforms
 * ship) so content written by this PR stays valid without a migration.
 *
 * Always root-relative - `media.publicBaseUrl` is editor-display-only (PR 6's
 * concern) and must never be baked into stored/served content URLs.
 */

import { ASSET_PREFIXES } from './keys'
import { IDENTITY_TRANSFORM_DIRECTIVE } from './transform-directives'
import type { AssetMeta } from './types'

/** Re-exported for existing importers (assets/index.ts barrel) - the value now lives in transform-directives.ts, PR 4's pure directive module, so it's reachable without pulling keys.ts's node:crypto import into client bundles. */
export { IDENTITY_TRANSFORM_DIRECTIVE }

export function assetSrc(meta: Pick<AssetMeta, 'hash32' | 'slug' | 'ext' | 'kind'>): string {
  if (meta.kind === 'svg' || meta.kind === 'pdf') {
    return `/${ASSET_PREFIXES.public}/${meta.hash32}/${meta.slug}.${meta.ext}`
  }
  return `/${ASSET_PREFIXES.transform}/${IDENTITY_TRANSFORM_DIRECTIVE}/${meta.hash32}/${meta.slug}.${meta.ext}`
}
