/**
 * Build/adjust transform URLs for `<img>`/srcset without pulling in the
 * server-only transform engine. Isomorphic - depends only on
 * transform-directives.ts, the plain `ASSET_PREFIXES` constant, and
 * utils/url-prefix.ts, none of which import node builtins, so this is safe to
 * import from client (editor) code as well as during static builds.
 */

import { joinUrlPrefix, sanitizeUnprefixedPath } from '../utils/url-prefix'
import { ASSET_PREFIXES } from './asset-prefixes'
import {
  formatDirectives,
  isAllowedTransformWidth,
  parseTransformPath,
  type CropRect,
  type OutputFormat,
  type TransformDirectives,
} from './transform-directives'

/** The minimal shape `assetUrl`/`assetSrcSet` need from a stored asset reference. */
export interface AssetRef {
  src: string
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
   *   `media.publicBaseUrl` is one source of this, and is the source the editor uses; it is
   *   validated as an absolute URL, so it structurally cannot carry the second shape.
   * - A same-origin path prefix (`/preview-123`) — the site is deployed under a Next `basePath`
   *   AND its assets are served by Next (`withCanopy`'s `/assets/:path*` rewrite, which Next
   *   auto-prefixes). NOT the right value on a CloudFront/CDK deployment, where the asset
   *   behaviors are anchored at the distribution root and a `basePath` does not move them —
   *   there the correct value is none at all. See the README's asset-mount table.
   *
   * It is a per-render option rather than a config field precisely because the editor and the
   * public site can legitimately have different answers.
   *
   * **Render-time only — never stored.** A stored `src` is always root-relative (see
   * `assets/asset-src.ts`), because content moves between branches and environments. Nothing
   * that writes content may bake this prefix in.
   */
  baseUrl?: string
}

const TRANSFORM_URL_PREFIX = `/${ASSET_PREFIXES.transform}/`

/**
 * Merge `opts` over an already-parsed directive set - opts win when given,
 * otherwise the existing value (if any) carries over. Returns `undefined`
 * fields as "unset" (there is no way to explicitly clear a directive via
 * opts - only to override it).
 */
function mergeDirectives(current: TransformDirectives, opts: AssetUrlOptions): TransformDirectives {
  const existing = current.identity ? undefined : current

  const width = opts.width ?? existing?.width
  const format = opts.format ?? existing?.format
  const quality = opts.quality ?? existing?.quality
  const crop = opts.crop ?? existing?.crop

  if (width === undefined && format === undefined && quality === undefined && crop === undefined) {
    return { identity: true }
  }
  return { identity: false, width, format, quality, crop }
}

/**
 * Build a transform URL, merging `opts` over the directives already present
 * in `ref.src` (opts win). For static srcs (svg/pdf under `/assets/{hash}/...`,
 * or any src that isn't one of our own transform URLs) the src is returned
 * unchanged and `opts` are ignored - there is nothing to transform.
 */
export function assetUrl(ref: AssetRef, opts: AssetUrlOptions = {}): string {
  const { src } = ref

  if (!src.startsWith(TRANSFORM_URL_PREFIX)) {
    // With no mount point to apply, a src we don't own comes back byte-identical - the README
    // routes every markdown/MDX body image through here so a basePath deployment can prefix them,
    // and bodies carry srcs canopycms never wrote: `data:` URIs, and page-relative paths whose
    // meaning would change if we rooted them. `sanitizeUnprefixedPath` still neutralizes a value
    // that a browser would read as off-origin, so "leave it alone" never means "emit `/\evil.com`".
    if (!opts.baseUrl) return sanitizeUnprefixedPath(src)
    return joinUrlPrefix(opts.baseUrl, src)
  }

  const rest = src.slice(TRANSFORM_URL_PREFIX.length)
  const parsed = parseTransformPath(rest.split('/'))
  if (!parsed.ok) {
    // Malformed src (shouldn't happen for a src canopycms itself wrote) -
    // nothing sensible to merge onto, so return it unchanged rather than throw.
    return joinUrlPrefix(opts.baseUrl, src)
  }

  const merged = mergeDirectives(parsed.directives, opts)
  // Ext follows the format: an explicit format (new or carried over) always
  // wins; with no format at all, the ext must keep preserving the source's
  // real extension, which is exactly what `parsed.ext` already is here.
  const ext = !merged.identity && merged.format !== undefined ? merged.format : parsed.ext

  const newSrc = `${TRANSFORM_URL_PREFIX}${formatDirectives(merged)}/${parsed.hash32}/${parsed.slug}.${ext}`
  return joinUrlPrefix(opts.baseUrl, newSrc)
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
