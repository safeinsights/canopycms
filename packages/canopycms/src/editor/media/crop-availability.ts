import { ASSET_PREFIXES } from '../../assets/asset-prefixes'
import { isAssetStoreSrc } from '../../assets/asset-url'

const TRANSFORM_SPACE_PREFIX = `/${ASSET_PREFIXES.transform}/`

/**
 * Why `src` can't be cropped, as the full sentence its disabled Crop button shows; `undefined`
 * when it can. A crop is a directive on a transform URL, which `assetUrl` writes only for a raster
 * in the asset store, so a vector file or a file outside the store never renders one.
 */
export function cropBlockedReason(src: string): string | undefined {
  const path = src.split(/[?#]/)[0] ?? src
  if (/\.svg$/i.test(path))
    return "SVG images can't be cropped. Replace it with a PNG or JPEG to crop it."
  if (!isAssetStoreSrc(src)) {
    return 'Crop works on media-library images. Replace this file with a library copy to crop it.'
  }
  if (!src.startsWith(TRANSFORM_SPACE_PREFIX))
    return "This file type can't be cropped. Replace it with a PNG or JPEG to crop it."
  return undefined
}
