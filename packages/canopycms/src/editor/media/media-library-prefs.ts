'use client'

import { useLocalStorage } from '@mantine/hooks'

import { isPlainRecord } from '../../validation/field-traversal'
import {
  MEDIA_DENSITIES,
  MEDIA_SORTS,
  type MediaDensity,
  type MediaSort,
} from './media-library-view'

/** The preferences that persist per viewer; the kind filter and search text do not. */
interface MediaLibraryPrefs {
  sort: MediaSort
  density: MediaDensity
}

/** @internal Exported for tests and stories. */
export const MEDIA_LIBRARY_PREFS_KEY = 'canopycms:media-library:prefs'

/** Module-level so its identity is stable: Mantine memoises its storage reader on the default. */
const DEFAULT_PREFS: MediaLibraryPrefs = { sort: 'newest', density: 'grid' }

const oneOf = <T extends string>(options: readonly T[], value: unknown, fallback: T): T =>
  options.find((option) => option === value) ?? fallback

/**
 * @internal Exported for tests. Validates each field on its own, so a bad one takes its default and the other is kept. Mantine
 * does not guard `deserialize`, so this never throws, whatever is under the key.
 */
export function parseMediaLibraryPrefs(raw: string | undefined): MediaLibraryPrefs {
  if (!raw) return DEFAULT_PREFS
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return DEFAULT_PREFS
  }
  if (!isPlainRecord(parsed)) return DEFAULT_PREFS
  return {
    sort: oneOf(MEDIA_SORTS, parsed.sort, DEFAULT_PREFS.sort),
    density: oneOf(MEDIA_DENSITIES, parsed.density, DEFAULT_PREFS.density),
  }
}

export interface UseMediaLibraryPrefsReturn extends MediaLibraryPrefs {
  setSort: (sort: MediaSort) => void
  setDensity: (density: MediaDensity) => void
}

/**
 * Sort and density, read from localStorage after mount (SSR renders the defaults). A storage that
 * throws leaves them in memory for the session.
 */
export function useMediaLibraryPrefs(): UseMediaLibraryPrefsReturn {
  const [prefs, setPrefs] = useLocalStorage<MediaLibraryPrefs>({
    key: MEDIA_LIBRARY_PREFS_KEY,
    defaultValue: DEFAULT_PREFS,
    deserialize: parseMediaLibraryPrefs,
    // Each tab keeps its own choice; a change elsewhere reaches only tabs opened later.
    sync: false,
  })
  return {
    sort: prefs.sort,
    density: prefs.density,
    setSort: (sort) => setPrefs((prev) => ({ ...prev, sort })),
    setDensity: (density) => setPrefs((prev) => ({ ...prev, density })),
  }
}
