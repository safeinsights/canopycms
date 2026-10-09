import { assetUrl, isAssetStoreSrc, type AssetUrlOptions } from '../../assets/asset-url'

/**
 * The URL the editor displays a content image at. An asset-store src goes behind `baseUrl` (the
 * authenticated raw route, see `AssetContext`) with `opts` applied; any other src is shown as
 * written, since the raw route serves only the asset store, though `assetUrl` still neutralizes an
 * off-origin spelling.
 */
export function editorImageSrc(
  src: string,
  baseUrl: string,
  opts: Omit<AssetUrlOptions, 'baseUrl'> = {},
): string {
  return isAssetStoreSrc(src) ? assetUrl({ src }, { ...opts, baseUrl }) : assetUrl({ src })
}
