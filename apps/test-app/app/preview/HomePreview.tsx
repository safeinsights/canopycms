'use client'

import { memo, type ReactNode } from 'react'
import { assetUrl, type CropRect } from 'canopycms'
import { withCanopyPreview, type CanopyPreviewViewProps } from 'canopycms-next/preview'
import { heroRef, type HomeData } from '../hero-ref'

export interface HomeExtras {
  /** Server-rendered by the route's `load`. */
  thumb: ReactNode
}

/** Re-renders only for a new src, so a draft that keeps the image never re-renders it. */
const StillHero = memo(
  function StillHero({ src, crop }: { src: string; crop?: CropRect }) {
    return (
      <img
        data-testid="still-hero"
        src={assetUrl({ src, crop }, { width: 560 })}
        alt=""
        width={64}
      />
    )
  },
  (before, after) => before.src === after.src,
)

function HomePreviewView({
  data,
  extras,
}: CanopyPreviewViewProps<HomeData> & { extras: HomeExtras | undefined }) {
  const hero = heroRef(data?.heroImage)
  return (
    <main data-testid="home-preview" className="p-8">
      <h1>{data?.title}</h1>
      {hero && (
        <>
          <img data-testid="preview-hero" src={assetUrl(hero, { width: 480 })} alt="" width={64} />
          <StillHero src={hero.src} crop={hero.crop} />
        </>
      )}
      {extras?.thumb}
    </main>
  )
}

export const HomePreview = withCanopyPreview<HomeData, HomeExtras>(HomePreviewView)
