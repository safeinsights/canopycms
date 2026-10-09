import { assetUrl, isAssetStoreSrc, type AssetUrlOptions } from '../../assets/asset-url'

/**
 * The URL the editor displays a content image at. An asset-store src goes behind `baseUrl` (the
 * authenticated raw route, see `AssetContext`) with `opts` applied. Any other src keeps its own
 * path, since the raw route serves only the asset store; `assetUrl` still neutralizes a spelling a
 * browser would read as off-origin.
 */
export function editorImageSrc(
  src: string,
  baseUrl: string,
  opts: Omit<AssetUrlOptions, 'baseUrl'> = {},
): string {
  return isAssetStoreSrc(src) ? assetUrl({ src }, { ...opts, baseUrl }) : assetUrl({ src })
}
