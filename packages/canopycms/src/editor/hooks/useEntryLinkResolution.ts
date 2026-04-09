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

const BASE58_CHAR = '[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]'
const ENTRY_LINK_PATTERN = new RegExp(`entry:(${BASE58_CHAR}{12})(#[^\\s)>"']*)?`, 'g')

/**
 * Build a Map from content IDs to URL paths from the editor entries list.
 */
function buildEntryUrlMap(entries: EditorEntry[], contentRoot?: string): Map<string, string> {
  const map = new Map<string, string>()
  const root = contentRoot ?? 'content'

  for (const entry of entries) {
    if (!entry.contentId || !entry.slug) continue

    const collection = entry.collectionPath ?? ''
    let stripped = collection as string
    if (root && stripped.startsWith(`${root}/`)) {
      stripped = stripped.slice(root.length + 1)
    } else if (stripped === root) {
      stripped = ''
    }

    const segments = stripped.split('/').filter(Boolean)
    if (entry.slug !== 'index') {
      segments.push(entry.slug)
    }

    const urlPath = segments.length > 0 ? `/${segments.join('/')}` : '/'
    map.set(entry.contentId, urlPath)
  }

  return map
}

/**
 * Replace entry:ID patterns in text using the provided URL map.
 * Lightweight client-side version (no code-block skipping needed since
 * the preview renderer handles code blocks independently).
 */
function resolveEntryLinksClient(text: string, urlMap: Map<string, string>): string {
  return text.replace(ENTRY_LINK_PATTERN, (_match, id: string, anchor?: string) => {
    const url = urlMap.get(id)
    if (!url) return `#${anchor ?? ''}`
    return `${url}${anchor ?? ''}`
  })
}

export interface UseEntryLinkResolutionOptions {
  entries: EditorEntry[]
  contentRoot?: string
}

/**
 * Hook that provides a function to resolve entry:ID patterns in body text.
 *
 * Usage in Editor.tsx:
 * ```ts
 * const { resolveEntryLinks } = useEntryLinkResolution({ entries, contentRoot })
 * const resolvedPreviewData = resolveEntryLinks(previewFrameData, bodyFieldNames)
 * ```
 */
export function useEntryLinkResolution({ entries, contentRoot }: UseEntryLinkResolutionOptions) {
  const urlMap = useMemo(() => buildEntryUrlMap(entries, contentRoot), [entries, contentRoot])

  /**
   * Resolve entry:ID patterns in all string values of the data object.
   * Only processes fields listed in `markdownFields` (or all string fields if not provided).
   */
  const resolveEntryLinks = useMemo(() => {
    return (
      data: Record<string, unknown>,
      markdownFields?: Set<string>,
    ): Record<string, unknown> => {
      if (urlMap.size === 0) return data

      let changed = false
      const resolved = { ...data }

      for (const [key, value] of Object.entries(resolved)) {
        if (typeof value !== 'string') continue
        if (markdownFields && !markdownFields.has(key)) continue
        if (!ENTRY_LINK_PATTERN.test(value)) continue

        // Reset lastIndex since we used .test() above
        ENTRY_LINK_PATTERN.lastIndex = 0
        resolved[key] = resolveEntryLinksClient(value, urlMap)
        changed = true
      }

      return changed ? resolved : data
    }
  }, [urlMap])

  return { resolveEntryLinks }
}
