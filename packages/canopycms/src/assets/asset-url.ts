/**
 * Build/adjust transform URLs for `<img>`/srcset without pulling in the
 * server-only transform engine. Isomorphic - none of its imports reach a node
 * builtin, so this is safe to import from client (editor) code as well as during
 * static builds.
 */

import {
  isUnprefixablePath,
  joinUrlPrefix,
  sanitizeUnprefixedPath,
  stripTrailingSlashes,
} from '../utils/url-prefix'
import { getPreviewAssetBase } from '../editor/preview-asset-base'
import { ASSET_PREFIXES } from './asset-prefixes'
import {
  formatDirectives,
  isAllowedTransformWidth,
  parseTransformPath,
  type CropRect,
  type OutputFormat,
  type TransformDirectives,
} from './transform-directives'

/**
 * The minimal shape `assetUrl`/`assetSrcSet` need from a stored asset reference. An
 * `ImageFieldValue` is one, so passing a field value renders the crop the editor stored.
 */
export interface AssetRef {
  src: string
  crop?: CropRect
}

export interface AssetUrlOptions {
  width?: number
  format?: OutputFormat
  quality?: number
  crop?: CropRect
  /**
   * Where the `/assets` URL space is mounted **as seen by this renderer**. Prefixed onto the
   * result at render time.
   *
   * This is the ONE prefix concept for asset URLs; there is deliberately no second "basePath"
   * option beside it. Two shapes are legitimate, and they are alternatives, never composed:
   *
   * - An absolute origin (`https://assets.example.com`) — assets served from another origin.
   * - A same-origin path prefix (`/preview-123`) — the site is deployed under a Next `basePath`
   *   AND its assets are served by Next (`withCanopy`'s `/assets/:path*` rewrite, which Next
   *   auto-prefixes). NOT the right value on a CloudFront/CDK deployment, where the asset
   *   behaviors are anchored at the distribution root and a `basePath` does not move them —
   *   there the correct value is none at all. See the README's asset-mount table.
   *
   * It is a per-render option rather than a config field because different renderers see the
   * `/assets` space at different places.
   *
   * **Render-time only — never stored.** A stored `src` is always root-relative (see
   * `assets/asset-src.ts`), because content moves between branches and environments. Nothing
   * that writes content may bake this prefix in.
   */
  baseUrl?: string
}

const TRANSFORM_URL_PREFIX = `/${ASSET_PREFIXES.transform}/`

/**
 * Merge `opts` and the ref's crop over the directives already in its src. Precedence per
 * directive: `opts`, then `ref.crop` (crop only), then the src. There is no way to clear a
 * directive, only to override it.
 */
function mergeDirectives(
  current: TransformDirectives,
  refCrop: CropRect | undefined,
  opts: AssetUrlOptions,
): TransformDirectives {
  const existing = current.identity ? undefined : current

  const width = opts.width ?? existing?.width
  const format = opts.format ?? existing?.format
  const quality = opts.quality ?? existing?.quality
  const crop = opts.crop ?? refCrop ?? existing?.crop

  if (width === undefined && format === undefined && quality === undefined && crop === undefined) {
    return { identity: true }
  }
  return { identity: false, width, format, quality, crop }
}

/**
 * Build a transform URL, merging `opts` and `ref.crop` over the directives already present
 * in `ref.src` (see `mergeDirectives` for precedence). For static srcs (svg/pdf under
 * `/assets/{hash}/...`, or any src that isn't one of our own transform URLs) the src is
 * returned unchanged and every directive is ignored - there is nothing to transform.
 *
 * In a live preview, a transform URL goes behind the editor's authenticated route
 * (`editor/preview-asset-base.ts`) instead of `opts.baseUrl`: a draft's crop or width may exist
 * nowhere a build put it. Static srcs keep `opts.baseUrl`, since finalize wrote them.
 */
export function assetUrl(ref: AssetRef, opts: AssetUrlOptions = {}): string {
  const { src } = ref

  if (!src.startsWith(TRANSFORM_URL_PREFIX)) {
    // A src canopycms doesn't own comes back byte-identical wherever it legitimately can. The
    // README routes every markdown/MDX body image through here so a basePath deployment can prefix
    // them, and bodies carry srcs we never wrote: `data:` URIs and off-site URLs, which no mount
    // point applies to. `sanitizeUnprefixedPath` still neutralizes a value that a browser would
    // read as off-origin, so "leave it alone" never means "emit `/\evil.com`".
    //
    // The mount test is `stripTrailingSlashes`, not just truthiness, so every spelling of "no
    // mount point" behaves the same: '', '/', '///' and '//' all mean root, matching
    // `joinUrlPrefix`'s own contract. Plain `!opts.baseUrl` made '' and '/' disagree.
    const mount = opts.baseUrl ? stripTrailingSlashes(opts.baseUrl) : ''
    if (!mount || isUnprefixablePath(src)) return sanitizeUnprefixedPath(src)
    return joinUrlPrefix(opts.baseUrl, src)
  }

  const base = getPreviewAssetBase() ?? opts.baseUrl
  const rest = src.slice(TRANSFORM_URL_PREFIX.length)
  const parsed = parseTransformPath(rest.split('/'))
  if (!parsed.ok) {
    // Malformed src (shouldn't happen for a src canopycms itself wrote) -
    // nothing sensible to merge onto, so return it unchanged rather than throw.
    return joinUrlPrefix(base, src)
  }

  const merged = mergeDirectives(parsed.directives, ref.crop, opts)
  // Ext follows the format: an explicit format (new or carried over) always
  // wins; with no format at all, the ext must keep preserving the source's
  // real extension, which is exactly what `parsed.ext` already is here.
  const ext = !merged.identity && merged.format !== undefined ? merged.format : parsed.ext

  const newSrc = `${TRANSFORM_URL_PREFIX}${formatDirectives(merged)}/${parsed.hash32}/${parsed.slug}.${ext}`
  return joinUrlPrefix(base, newSrc)
}

/**
 * Build a comma-joined `url w` srcset descriptor list. `widths` must all be
 * on the transform width allowlist (multiples of 160 in [160, 4096]) - this
 * is developer-facing (a host app's own responsive-image markup), so an
 * invalid width throws rather than silently dropping it.
 */
export function assetSrcSet(
  ref: AssetRef,
  widths: readonly number[],
  opts: Omit<AssetUrlOptions, 'width'> = {},
): string {
  return widths
    .map((width) => {
      if (!isAllowedTransformWidth(width)) {
        throw new Error(
          `assetSrcSet: width ${width} is not allowed (must be a multiple of 160 between 160 and 4096)`,
        )
      }
      return `${assetUrl(ref, { ...opts, width })} ${width}w`
    })
    .join(', ')
}
