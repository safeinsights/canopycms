/**
 * The five S3/local bucket-prefix strings (see keys.ts's module doc for the
 * full layout: asset-originals/, asset-staging/, asset-meta/, assets/t/,
 * assets/).
 *
 * Split into its own dependency-free file so client-safe, isomorphic modules
 * (transform-directives.ts, asset-url.ts) can import the prefix strings
 * directly without pulling keys.ts's `node:crypto` import (used only by
 * `hashBytes`) into a browser bundle. keys.ts re-exports `ASSET_PREFIXES`
 * from here so existing imports of it from './keys' keep working unchanged.
 */

export const ASSET_PREFIXES = {
  originals: 'asset-originals',
  staging: 'asset-staging',
  meta: 'asset-meta',
  public: 'assets',
  /** Transform-output prefix; directive-aware key building lives in transform-directives.ts. */
  transform: 'assets/t',
} as const

/**
 * Widened to plain `string` fields (not `typeof ASSET_PREFIXES`'s literal
 * types) so overriding stores can supply their own prefix strings.
 */
export interface AssetPrefixes {
  originals: string
  staging: string
  meta: string
  public: string
  transform: string
}
