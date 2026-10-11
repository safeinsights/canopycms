import type { AssetRecord } from '../../api'

export type MediaSort = 'newest' | 'name'
export type MediaDensity = 'grid' | 'compact' | 'list'
export type MediaKind = 'all' | 'images' | 'pdfs'

export const MEDIA_SORTS: readonly MediaSort[] = ['newest', 'name']
export const MEDIA_DENSITIES: readonly MediaDensity[] = ['grid', 'compact', 'list']

const uploadedAtMs = (asset: AssetRecord): number => {
  const ms = Date.parse(asset.uploadedAt)
  return Number.isNaN(ms) ? 0 : ms
}

const byNewest = (a: AssetRecord, b: AssetRecord): number => uploadedAtMs(b) - uploadedAtMs(a)

const byFilename = (a: AssetRecord, b: AssetRecord): number =>
  a.filename.localeCompare(b.filename, undefined, { sensitivity: 'base', numeric: true })

/**
 * Orders every loaded asset. The list API pages in storage order, so the order is only
 * meaningful here, across everything loaded.
 */
export function sortAssets(assets: readonly AssetRecord[], sort: MediaSort): AssetRecord[] {
  const compare =
    sort === 'name'
      ? (a: AssetRecord, b: AssetRecord) => byFilename(a, b) || byNewest(a, b)
      : (a: AssetRecord, b: AssetRecord) => byNewest(a, b) || byFilename(a, b)
  return [...assets].sort(compare)
}

export function matchesKind(asset: AssetRecord, kind: MediaKind): boolean {
  if (kind === 'pdfs') return asset.kind === 'pdf'
  if (kind === 'images') return asset.kind !== 'pdf'
  return true
}

/** `needle` is already trimmed and lower-cased; an empty needle matches everything. */
export function matchesText(asset: AssetRecord, needle: string): boolean {
  if (!needle) return true
  return asset.filename.toLowerCase().includes(needle) || asset.slug.toLowerCase().includes(needle)
}

/** "1 asset", "2 assets". */
export const assetCountLabel = (count: number): string =>
  `${count} ${count === 1 ? 'asset' : 'assets'}`

/** Grid columns per layout; the loading skeleton uses the same ones so nothing shifts. */
export const GRID_COLUMNS = {
  grid: { base: 2, sm: 3, md: 4 },
  compact: { base: 3, sm: 5, md: 6 },
} as const

/** Card thumbnail heights in px, shared with the skeleton that stands in for them. */
export const CARD_THUMBNAIL_HEIGHT = { grid: 100, compact: 64 } as const
