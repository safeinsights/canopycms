import { assetUrl } from '../../assets/asset-url'
import { ASSET_PREFIXES } from '../../assets/asset-prefixes'

const ASSET_SPACE = `/${ASSET_PREFIXES.public}/`

/**
 * The URL the editor displays a content image at. A src in canopycms's own `/assets` space is put
 * behind `baseUrl` (the authenticated raw route, see `AssetContext`); any other src - a site's own
 * static file, an off-site URL, a `data:` URI - is shown exactly as written, because the raw route
 * serves only the asset store.
 */
export function editorImageSrc(src: string, baseUrl: string): string {
  return src.startsWith(ASSET_SPACE) ? assetUrl({ src }, { baseUrl }) : src
}
