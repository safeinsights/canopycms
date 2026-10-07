'use client'

import { assetSrcSet, assetUrl, type AssetRef } from 'canopycms'

export default function BannerGallery({ banner }: { banner: AssetRef }) {
  return (
    <picture>
      <source type="image/webp" srcSet={assetSrcSet(banner, [480, 960], { format: 'webp' })} />
      <img src={assetUrl(banner, { width: 480 })} alt="" />
    </picture>
  )
}
