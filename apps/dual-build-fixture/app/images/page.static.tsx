// Static export only: the page dual-build.test.ts runs `canopycms collect-asset-refs` against.
import { assetSrcSet, assetUrl } from 'canopycms'

import BannerGallery from './BannerGallery'
import { BANNER, CDN_ORIGIN, LOGO, PHOTO } from './image-refs'
import { installAssetUrlRecorder } from './record-asset-urls'

installAssetUrlRecorder()

export default function ImagesPage() {
  return (
    <main>
      <img
        src={assetUrl(PHOTO, { width: 640 })}
        srcSet={assetSrcSet(PHOTO, [320, 640, 1280])}
        sizes="(max-width: 640px) 100vw, 640px"
        alt=""
      />
      <img src={assetUrl(PHOTO, { width: 960, format: 'webp', baseUrl: CDN_ORIGIN })} alt="" />
      <img src={assetUrl(LOGO, { baseUrl: CDN_ORIGIN })} alt="" />
      <BannerGallery banner={BANNER} />
    </main>
  )
}
