import type { AssetRef } from 'canopycms'

export interface HomeData {
  title?: string
  tagline?: string
  published?: boolean
  heroImage?: AssetRef & { alt?: string }
}

const STORED_RASTER_SRC = /^\/assets\/t\/orig\/([0-9a-f]{32})\/([a-z0-9-]+)\.([a-z0-9]+)$/

/**
 * Draft data arrives by postMessage, so the hero's src is rebuilt from its validated parts rather
 * than rendered as given, and anything but a stored raster src renders nothing.
 */
export function heroRef(value: HomeData['heroImage']): HomeData['heroImage'] {
  const match = value && STORED_RASTER_SRC.exec(value.src)
  if (!value || !match) return undefined
  const [hash32, slug, ext] = match.slice(1).map(encodeURIComponent)
  return { src: `/assets/t/orig/${hash32}/${slug}.${ext}`, crop: value.crop, alt: value.alt }
}
