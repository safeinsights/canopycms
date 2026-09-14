/**
 * Entry link resolution for body content: `entry:CONTENT_ID` tokens in markdown/MDX
 * text resolve to URL paths, extending the reference-by-ID pattern from structured
 * reference fields to inline body links.
 *
 *   [Link text](entry:vh2WdhwAFiSL)
 *   [Link text](entry:vh2WdhwAFiSL#section-heading)
 *
 * Fenced code blocks and inline code spans are skipped, so code examples are never
 * rewritten.
 */

import type { ContentIdIndex, IdLocation } from './content-id-index'
import { createDebugLogger } from './utils/debug'
import { computeEntryUrl } from './utils/entry-url'

const log = createDebugLogger({ prefix: 'EntryLinks' })

/** Base58 alphabet character class (excludes ambiguous: 0, O, I, l). */
export const BASE58_CHAR = '[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]'

/**
 * Pattern matching `entry:CONTENT_ID` with optional anchor fragment.
 * Uses the `g` flag — safe to share when used only with `.replace()`.
 */
export const ENTRY_LINK_PATTERN = new RegExp(`entry:(${BASE58_CHAR}{12})(#[^\\s)>"']*)?`, 'g')

/** Custom URL resolver callback type */
export type EntryLinkUrlResolver = (entry: {
  collection: string
  slug: string
  id: string
}) => string

/** URL path for an entry's location in the content tree; delegates to `computeEntryUrl`. */
export function resolveEntryUrl(
  location: Pick<IdLocation, 'collection' | 'slug'>,
  contentRoot: string,
): string {
  return computeEntryUrl(location.collection ?? '', location.slug ?? '', contentRoot)
}

/**
 * Replace `entry:CONTENT_ID` tokens with resolved URL paths, skipping code blocks and
 * spans so examples mentioning the syntax survive. A missing ID becomes "#" (dead link)
 * plus a warning; an anchor fragment is preserved (`entry:ID#heading` => `/path#heading`).
 */
export function resolveEntryLinksInText(
  text: string,
  idIndex: ContentIdIndex,
  contentRoot: string,
  customResolver?: EntryLinkUrlResolver,
): string {
  const parts = splitByCodeRegions(text)

  return parts
    .map((part) => {
      if (part.isCode) return part.text
      return part.text.replace(ENTRY_LINK_PATTERN, (_match, id: string, anchor?: string) => {
        const location = idIndex.findById(id)

        if (!location || location.type !== 'entry' || !location.collection || !location.slug) {
          log.warn('resolve', `Entry link target not found: entry:${id}`)
          return anchor ?? '#'
        }

        let url: string
        if (customResolver) {
          url = customResolver({
            collection: location.collection,
            slug: location.slug,
            id,
          })
        } else {
          url = resolveEntryUrl(location, contentRoot)
        }

        return `${url}${anchor ?? ''}`
      })
    })
    .join('')
}

/** Quick-check pattern for early bail-out (no `g` flag, safe for `.test()`). */
export const ENTRY_LINK_QUICK_CHECK =
  /entry:[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{12}/

/**
 * Recursively resolve `entry:ID` tokens in every string of a data structure — nested
 * objects and arrays included, since JSON entries keep markdown fields inside nested
 * objects (e.g. hero.body). Returns the same reference when nothing changed.
 */
export function resolveEntryLinksInData(
  data: unknown,
  idIndex: ContentIdIndex,
  contentRoot: string,
  customResolver?: EntryLinkUrlResolver,
): unknown {
  if (typeof data === 'string') {
    if (!ENTRY_LINK_QUICK_CHECK.test(data)) return data
    return resolveEntryLinksInText(data, idIndex, contentRoot, customResolver)
  }

  if (Array.isArray(data)) {
    let changed = false
    const result = data.map((item) => {
      const resolved = resolveEntryLinksInData(item, idIndex, contentRoot, customResolver)
      if (resolved !== item) changed = true
      return resolved
    })
    return changed ? result : data
  }

  if (data != null && typeof data === 'object') {
    let changed = false
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      const resolved = resolveEntryLinksInData(value, idIndex, contentRoot, customResolver)
      result[key] = resolved
      if (resolved !== value) changed = true
    }
    return changed ? result : data
  }

  return data
}

/** Every entry link ID in text, skipping code blocks — for validation, not resolution. */
export function extractEntryLinkIds(text: string): Array<{ id: string; anchor?: string }> {
  const parts = splitByCodeRegions(text)
  const results: Array<{ id: string; anchor?: string }> = []

  for (const part of parts) {
    if (part.isCode) continue
    // `ENTRY_LINK_PATTERN.source` is a fixed compile-time pattern, not attacker-controlled
    // input. A fresh instance per part keeps this exec() loop from mutating the shared
    // `g`-flagged pattern's `lastIndex`.
    // eslint-disable-next-line security/detect-non-literal-regexp
    const regex = new RegExp(ENTRY_LINK_PATTERN.source, 'g')
    let match
    while ((match = regex.exec(part.text)) !== null) {
      results.push({
        id: match[1],
        anchor: match[2] || undefined,
      })
    }
  }

  return results
}

interface TextPart {
  text: string
  isCode: boolean
}

/**
 * Split text into alternating code/non-code regions — fenced blocks (``` or ~~~, language
 * tags included) and inline spans (`code`, ``code``) — so `entry:ID` inside code is never
 * resolved.
 */
function splitByCodeRegions(text: string): TextPart[] {
  const parts: TextPart[] = []
  let current = ''
  let i = 0

  while (i < text.length) {
    if (
      (text[i] === '`' || text[i] === '~') &&
      i + 2 < text.length &&
      text[i + 1] === text[i] &&
      text[i + 2] === text[i]
    ) {
      const fence = text[i]
      let fenceLen = 0
      while (i + fenceLen < text.length && text[i + fenceLen] === fence) fenceLen++

      const lineEnd = text.indexOf('\n', i + fenceLen)
      if (lineEnd === -1) {
        // No newline — rest of text is code block
        if (current) parts.push({ text: current, isCode: false })
        parts.push({ text: text.slice(i), isCode: true })
        return parts
      }

      const closingPattern = fence.repeat(fenceLen)
      let closeStart = lineEnd + 1
      let found = false

      while (closeStart < text.length) {
        const nextNewline = text.indexOf('\n', closeStart)
        const lineContent =
          nextNewline === -1 ? text.slice(closeStart) : text.slice(closeStart, nextNewline)

        if (lineContent.trim().startsWith(closingPattern)) {
          const endPos = nextNewline === -1 ? text.length : nextNewline + 1
          if (current) parts.push({ text: current, isCode: false })
          current = ''
          parts.push({ text: text.slice(i, endPos), isCode: true })
          i = endPos
          found = true
          break
        }

        if (nextNewline === -1) break
        closeStart = nextNewline + 1
      }

      if (!found) {
        // Unclosed code block — treat rest as code
        if (current) parts.push({ text: current, isCode: false })
        parts.push({ text: text.slice(i), isCode: true })
        return parts
      }
      continue
    }

    if (text[i] === '`') {
      let ticks = 0
      while (i + ticks < text.length && text[i + ticks] === '`') ticks++

      const closer = '`'.repeat(ticks)
      const closeIdx = text.indexOf(closer, i + ticks)

      if (closeIdx !== -1) {
        if (current) parts.push({ text: current, isCode: false })
        current = ''
        parts.push({ text: text.slice(i, closeIdx + ticks), isCode: true })
        i = closeIdx + ticks
        continue
      }

      // No closing backticks — treat as regular text
      current += text.slice(i, i + ticks)
      i += ticks
      continue
    }

    current += text[i]
    i++
  }

  if (current) parts.push({ text: current, isCode: false })
  return parts
}
