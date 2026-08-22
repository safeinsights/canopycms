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
 * Always root-relative, and this is the value that gets STORED in content.
 * Content moves between branches and environments, so a stored src must not
 * name an origin or a deployment prefix - it names only the asset's position
 * in the `/assets` URL space.
 *
 * Prefixing is a separate, render-time concern: `assetUrl()`'s `baseUrl` option
 * (assets/asset-url.ts) puts the mount point in front, and is the ONLY place a
 * prefix is applied. Do not confuse the two:
 *
 * - `assetSrc()` (here)        -> stored, always root-relative, no prefix ever.
 * - `assetUrl(ref, {baseUrl})` -> rendered, prefix applied, never written back.
 *
 * `media.publicBaseUrl` is one source of that render-time prefix (the editor's,
 * for when the editor is served from a different origin) - it is config for
 * display, not a property of the asset.
 */

import { ASSET_PREFIXES } from './asset-prefixes'
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
