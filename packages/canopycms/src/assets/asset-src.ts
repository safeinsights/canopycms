/**
 * Compute the root-relative public URL for an asset's meta.
 *
 * svg/pdf: served statically from the public object finalize wrote
 * (`assets/{hash32}/{slug}.{ext}`, via keys.ts's `publicKey`).
 *
 * raster: served through the transform layer using the `orig` (identity)
 * directive.
 *
 * Always root-relative, and this is the value that gets STORED in content.
 * Content moves between branches and environments, so a stored src must not
 * name an origin or a deployment prefix - it names only the asset's position
 * in the `/assets` URL space. Prefixing it for display is `assetUrl()`'s
 * render-time job - see asset-url.ts.
 */

import { ASSET_PREFIXES } from './asset-prefixes'
import { IDENTITY_TRANSFORM_DIRECTIVE } from './transform-directives'
import type { AssetMeta } from './types'

/** Re-exported for existing importers (assets/index.ts barrel) - the value now lives in transform-directives.ts, so it's reachable without pulling keys.ts's node:crypto import into client bundles. */
export { IDENTITY_TRANSFORM_DIRECTIVE }

export function assetSrc(meta: Pick<AssetMeta, 'hash32' | 'slug' | 'ext' | 'kind'>): string {
  if (meta.kind === 'svg' || meta.kind === 'pdf') {
    return `/${ASSET_PREFIXES.public}/${meta.hash32}/${meta.slug}.${meta.ext}`
  }
  return `/${ASSET_PREFIXES.transform}/${IDENTITY_TRANSFORM_DIRECTIVE}/${meta.hash32}/${meta.slug}.${meta.ext}`
}
