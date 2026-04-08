/**
 * MDX component transform engine for AI content generation.
 *
 * Parses JSX components from MDX body content and applies adopter-defined
 * transforms to convert them to clean markdown. Components inside fenced
 * code blocks are left untouched.
 *
 * Uses a convergence loop: each pass transforms the innermost matching
 * components, so nested components are handled naturally (inner first,
 * outer on subsequent passes).
 */

import type { ComponentProps, ComponentTransforms } from './types'

/**
 * Parse JSX attribute string into a props object.
 *
 * Handles: `key="value"`, `key='value'`, `key={expr}`, and boolean `key` (→ "true").
 */
export function parseComponentProps(attrString: string): ComponentProps {
  const props: ComponentProps = {}
  if (!attrString) return props

  // Match attribute patterns: name="value", name='value', name={expr}, or bare name
  // eslint-disable-next-line security/detect-unsafe-regex
  const attrRegex = /(\w+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}))?/g
  let match: RegExpExecArray | null

  while ((match = attrRegex.exec(attrString)) !== null) {
    const name = match[1]
    // Double-quoted, single-quoted, expression, or boolean
    const value = match[2] ?? match[3] ?? match[4] ?? 'true'
    props[name] = value
  }

  return props
}

/**
 * Mask fenced code blocks so component transforms don't touch them.
 * Returns the masked string and a restore function.
 */
const BLOCK_PREFIX = '<<CODEBLOCK'
const BLOCK_SUFFIX = '>>'
const BLOCK_RESTORE_RE = /<<CODEBLOCK(\d+)>>/g

function maskCodeBlocks(body: string): { masked: string; restore: (s: string) => string } {
  const placeholders: string[] = []
  const masked = body.replace(/^(```|~~~).*\n[\s\S]*?\n\1\s*$/gm, (block) => {
    const idx = placeholders.length
    placeholders.push(block)
    return `${BLOCK_PREFIX}${idx}${BLOCK_SUFFIX}`
  })
  return {
    masked,
    restore: (s: string) => s.replace(BLOCK_RESTORE_RE, (_, i) => placeholders[Number(i)]),
  }
}

/**
 * Apply component transforms to a body string.
 *
 * For each registered component name, finds JSX tags in the body and calls
 * the corresponding transform function. Processes via convergence loop to
 * handle nesting (inner components first, outer on subsequent passes).
 */
export function applyComponentTransforms(body: string, transforms: ComponentTransforms): string {
  const names = Object.keys(transforms)
  if (names.length === 0) return body

  // Mask code blocks to protect them from transformation
  const { masked, restore } = maskCodeBlocks(body)
  let result = masked

  const MAX_PASSES = 10

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let changed = false

    for (const name of names) {
      const transform = transforms[name]

      // Match self-closing tags: <Name ... />
      // eslint-disable-next-line security/detect-non-literal-regexp
      const selfClosingRegex = new RegExp(`<${escapeRegex(name)}(\\s[^>]*?)?\\s*/>`, 'g')
      result = result.replace(selfClosingRegex, (raw, attrStr) => {
        const props = parseComponentProps(attrStr?.trim() ?? '')
        const replacement = transform(props, '')
        if (replacement === undefined) return raw
        changed = true
        return replacement
      })

      // Match opening + closing tag pairs: <Name ...>children</Name>
      // Search from an advancing offset to handle undefined (passthrough) returns
      // eslint-disable-next-line security/detect-non-literal-regexp
      const openRegex = new RegExp(`<${escapeRegex(name)}(\\s[^>]*)?>`, 'g')
      let openMatch: RegExpExecArray | null

      while ((openMatch = openRegex.exec(result)) !== null) {
        const openStart = openMatch.index
        const openEnd = openStart + openMatch[0].length
        const attrStr = openMatch[1]?.trim() ?? ''

        // Find matching close tag, accounting for nesting
        const closeTag = `</${name}>`
        const closeIdx = findMatchingClose(result, openEnd, name, closeTag)
        if (closeIdx === -1) break // unmatched — stop processing this component

        const children = result.slice(openEnd, closeIdx)
        const fullEnd = closeIdx + closeTag.length

        const props = parseComponentProps(attrStr)
        const replacement = transform(props, children)
        if (replacement === undefined) {
          // Skip past this match — advance regex past the closing tag
          openRegex.lastIndex = fullEnd
          continue
        }

        result = result.slice(0, openStart) + replacement + result.slice(fullEnd)
        changed = true
        // Reset regex to search from replacement position (it may be shorter/longer)
        openRegex.lastIndex = openStart + replacement.length
      }
    }

    if (!changed) break
  }

  return restore(result)
}

/**
 * Find the index of the matching closing tag, accounting for nested
 * instances of the same component.
 */
function findMatchingClose(
  body: string,
  startFrom: number,
  name: string,
  closeTag: string,
): number {
  let depth = 1
  const pos = startFrom

  // Regex to find either an opening or closing tag for this component
  // eslint-disable-next-line security/detect-non-literal-regexp
  const tagRegex = new RegExp(
    `<${escapeRegex(name)}(?:\\s[^>]*)?>|<${escapeRegex(name)}(?:\\s[^>]*)?\\s*/>|${escapeRegex(closeTag)}`,
    'g',
  )
  tagRegex.lastIndex = pos

  let match: RegExpExecArray | null
  while ((match = tagRegex.exec(body)) !== null) {
    const tag = match[0]
    if (tag === closeTag) {
      depth--
      if (depth === 0) return match.index
    } else if (!tag.endsWith('/>')) {
      // Opening tag (not self-closing)
      depth++
    }
    // Self-closing tags don't affect depth
  }

  return -1
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
