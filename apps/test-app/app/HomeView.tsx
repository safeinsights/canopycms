'use client'

import { assetUrl, type AssetRef } from 'canopycms'
import { useCanopyPreview } from 'canopycms/client'

interface HomeData {
  title?: string
  tagline?: string
  published?: boolean
  heroImage?: AssetRef & { alt?: string }
}

/** One distinct transform per width, so the preview requests 24 derivatives at once. */
const HERO_WIDTHS = Array.from({ length: 24 }, (_, i) => 160 * (i + 1))

export default function HomeView({ initialData = {} }: { initialData?: HomeData }) {
  const { data, fieldProps } = useCanopyPreview<HomeData>({ initialData })
  const hero = data?.heroImage

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-8">
      <h1 className="text-4xl font-bold mb-4" {...fieldProps('title')}>
        {data?.title ?? 'CanopyCMS Test App'}
      </h1>
      <p className="text-gray-600 mb-8" {...fieldProps('tagline')}>
        {data?.tagline ?? 'This app is for Playwright E2E testing'}
      </p>
      {hero?.src && (
        <div
          className="flex flex-wrap gap-1 mb-8"
          data-testid="hero-widths"
          {...fieldProps('heroImage')}
        >
          {HERO_WIDTHS.map((width) => (
            <img key={width} src={assetUrl(hero, { width })} alt={hero.alt ?? ''} width={64} />
          ))}
        </div>
      )}
      <a href="/edit" className="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700">
        Open Editor
      </a>
    </main>
  )
}
