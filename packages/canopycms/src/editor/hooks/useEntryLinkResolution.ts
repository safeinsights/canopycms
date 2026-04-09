/**
 * Client-side entry link resolution for live preview.
 *
 * Builds a Map<contentId, urlPath> from the loaded editor entries,
 * then provides a function to resolve entry:ID patterns in text.
 * Used to transform body content before it reaches the PreviewFrame,
 * so the preview iframe receives fully-resolved URLs.
 */

import { useMemo } from 'react'
import type { EditorEntry } from '../Editor'
import { computeEntryUrl } from '../../utils/entry-url'
import {
  ENTRY_LINK_PATTERN,
  ENTRY_LINK_QUICK_CHECK,
  type EntryLinkUrlResolver,
} from '../../entry-link-resolver'

/**
 * Build a Map from content IDs to URL info from the editor entries list.
 * Uses the shared computeEntryUrl utility (same logic as the server).
 */
function buildEntryUrlMap(
  entries: EditorEntry[],
  contentRoot: string,
  customResolver?: EntryLinkUrlResolver,
): Map<string, string> {
  const map = new Map<string, string>()

  for (const entry of entries) {
    if (!entry.contentId || !entry.slug) continue

    const collection = (entry.collectionPath ?? '') as string
    const url = customResolver
      ? customResolver({ collection, slug: entry.slug, id: entry.contentId })
      : computeEntryUrl(collection, entry.slug, contentRoot)

    map.set(entry.contentId, url)
  }

  return map
}

/**
 * Replace entry:ID patterns in text using the provided URL map.
 * Lightweight client-side version — does not skip code blocks since the
 * preview renderer handles code blocks independently. This means entry:ID
 * inside code blocks will resolve in preview but not in published output
 * (where the server-side resolver skips code blocks). Acceptable trade-off
 * for keeping the client bundle small.
 */
function resolveEntryLinksClient(text: string, urlMap: Map<string, string>): string {
  return text.replace(ENTRY_LINK_PATTERN, (_match, id: string, anchor?: string) => {
    const url = urlMap.get(id)
    if (!url) return anchor ?? '#'
    return `${url}${anchor ?? ''}`
  })
}

/**
 * Recursively resolve entry:ID patterns in all string values of a data structure.
 * Handles nested objects and arrays (e.g., hero.body inside a JSON entry).
 * Returns the same reference if nothing changed (structural sharing).
 */
function resolveDeep(data: unknown, urlMap: Map<string, string>): unknown {
  if (typeof data === 'string') {
    if (!ENTRY_LINK_QUICK_CHECK.test(data)) return data
    return resolveEntryLinksClient(data, urlMap)
  }

  if (Array.isArray(data)) {
    let changed = false
    const result = data.map((item) => {
      const resolved = resolveDeep(item, urlMap)
      if (resolved !== item) changed = true
      return resolved
    })
    return changed ? result : data
  }

  if (data != null && typeof data === 'object') {
    let changed = false
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      const resolved = resolveDeep(value, urlMap)
      result[key] = resolved
      if (resolved !== value) changed = true
    }
    return changed ? result : data
  }

  return data
}

export interface UseEntryLinkResolutionOptions {
  entries: EditorEntry[]
  contentRoot?: string
  /** Custom URL resolver — matches the server-side entryLinkUrl config option. */
  entryLinkUrl?: EntryLinkUrlResolver
}

/**
 * Hook that provides a function to resolve entry:ID patterns in data.
 *
 * Recursively walks nested objects/arrays so markdown fields inside
 * structured data (e.g., hero.body) are resolved for the preview.
 */
export function useEntryLinkResolution({
  entries,
  contentRoot,
  entryLinkUrl,
}: UseEntryLinkResolutionOptions) {
  const urlMap = useMemo(
    () => buildEntryUrlMap(entries, contentRoot ?? 'content', entryLinkUrl),
    [entries, contentRoot, entryLinkUrl],
  )

  const resolveEntryLinks = useMemo(() => {
    return (data: Record<string, unknown>): Record<string, unknown> => {
      if (urlMap.size === 0) return data
      return resolveDeep(data, urlMap) as Record<string, unknown>
    }
  }, [urlMap])

  return { resolveEntryLinks }
}
