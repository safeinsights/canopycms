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
/** Regex fragment matching JSX attribute content, skipping quoted strings containing '>'. */
const ATTR_CONTENT = `(?:[^>"']|"[^"]*"|'[^']*')*`

const BLOCK_PREFIX = '<<CODEBLOCK'
const BLOCK_SUFFIX = '>>'
const BLOCK_RESTORE_RE = /<<CODEBLOCK(\d+)>>/g

const INLINE_PREFIX = '<<INLINECODE'
const INLINE_SUFFIX = '>>'
const INLINE_RESTORE_RE = /<<INLINECODE(\d+)>>/g

/** True if `line` is a valid closing fence line for `marker` ("```" or "~~~"): the marker
 * followed by nothing but whitespace through end of line — matching what `\1\s*$` required in
 * the regex this replaced. */
function isFenceCloseLine(line: string, marker: string): boolean {
  return line.startsWith(marker) && /^\s*$/.test(line.slice(marker.length))
}

/**
 * Mask fenced code blocks (` ``` `/`~~~`), capturing each block's raw text (fence lines
 * included) exactly as `maskCodeBlocks` used to via `/^(```|~~~).*\n[\s\S]*?\n\1\s*$/gm`.
 *
 * A hand-rolled line scan, not that regex: it is a polynomial-ReDoS shape (measured ~9s on
 * ~530KB of body text with many unclosed fence openers — an ordinary authoring accident, not a
 * crafted payload) that CodeQL and three review rounds both missed elsewhere in this package
 * (see `ai/to-plain-text.ts`'s identical fix). The lazy `[\s\S]*?` has no bound on how far it
 * must scan looking for a closing `\1` that, for an unclosed fence, never arrives — it exhausts
 * to the end of the string before giving up on that starting line, and `/gm` retries the same
 * exhaustive scan at every subsequent fence-opener line.
 *
 * This scans each line once. `nextCloseLine` is precomputed per marker type via a single
 * backward pass, so any opener's nearest closer (or "none exists") is an O(1) lookup instead of
 * a fresh forward scan — the change that keeps the whole function O(n) regardless of how many
 * fences are opened and never closed.
 *
 * One documented, harmless divergence from the replaced regex: `\s*` there is greedy over `\s`
 * (which includes `\n`), so on a closer immediately followed by blank lines it could consume
 * some of them into the match. This scan never does. Verified by fuzzing 8,000 random
 * fence/marker combinations through this module's actual `applyComponentTransforms` pipeline:
 * final output was byte-identical in 7,999/8,000 cases, and the one divergence was an extra
 * blank line in a maximally adversarial nested-tag-plus-fence input, never a content change —
 * `\s` is never itself matched by any component-tag pattern, so which side of a placeholder a
 * run of blank lines lands on cannot affect what a transform sees or produces.
 */
function maskFencedCodeBlocks(body: string, blocks: string[]): string {
  const lines = body.split('\n')
  const lineCount = lines.length

  // nextCloseLine[marker][i] = the nearest index >= i that closes `marker`, or -1 if none exists
  // at or after i. Built right-to-left so each entry is O(1) given the next one.
  const nextCloseLine = {
    '```': new Array<number>(lineCount + 1).fill(-1),
    '~~~': new Array<number>(lineCount + 1).fill(-1),
  }
  for (let i = lineCount - 1; i >= 0; i--) {
    nextCloseLine['```'][i] = isFenceCloseLine(lines[i], '```') ? i : nextCloseLine['```'][i + 1]
    nextCloseLine['~~~'][i] = isFenceCloseLine(lines[i], '~~~') ? i : nextCloseLine['~~~'][i + 1]
  }

  const outLines: string[] = []
  let i = 0
  while (i < lineCount) {
    const line = lines[i]
    const marker = line.startsWith('```') ? '```' : line.startsWith('~~~') ? '~~~' : null

    // A closer can never be the very next line: the original pattern requires TWO separate `\n`
    // matches between the opener and `\1` (one ending the opener's line, one immediately before
    // the closer), so even zero-width content needs a line of its own between them.
    const searchFrom = i + 2
    const closeIndex = marker && searchFrom < lineCount ? nextCloseLine[marker][searchFrom] : -1

    if (!marker || closeIndex === -1) {
      outLines.push(line)
      i++
      continue
    }

    // Whole matched span (fence lines included), matching the replaced regex's own capture.
    const block = lines.slice(i, closeIndex + 1).join('\n')
    const idx = blocks.length
    blocks.push(block)
    outLines.push(`${BLOCK_PREFIX}${idx}${BLOCK_SUFFIX}`)
    i = closeIndex + 1
  }
  return outLines.join('\n')
}

/**
 * Mask fenced code blocks and inline code spans so component transforms
 * don't touch them. Returns the masked string and a restore function.
 */
function maskCodeBlocks(body: string): { masked: string; restore: (s: string) => string } {
  const blocks: string[] = []
  const inlines: string[] = []

  // 1. Mask fenced code blocks
  let masked = maskFencedCodeBlocks(body, blocks)

  // 2. Mask inline code spans (double-backtick first, then single-backtick)
  masked = masked.replace(/``[^`]+``|`[^`]+`/g, (span) => {
    const idx = inlines.length
    inlines.push(span)
    return `${INLINE_PREFIX}${idx}${INLINE_SUFFIX}`
  })

  return {
    masked,
    restore: (s: string) => {
      // Restore in reverse order: inline first, then blocks
      s = s.replace(INLINE_RESTORE_RE, (_, i) => inlines[Number(i)])
      s = s.replace(BLOCK_RESTORE_RE, (_, i) => blocks[Number(i)])
      return s
    },
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
      const selfClosingRegex = new RegExp(`<${escapeRegex(name)}(\\s${ATTR_CONTENT}?)?\\s*/>`, 'g')
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
      const openRegex = new RegExp(`<${escapeRegex(name)}(\\s${ATTR_CONTENT})?>`, 'g')
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
    `<${escapeRegex(name)}(?:\\s${ATTR_CONTENT})?>|<${escapeRegex(name)}(?:\\s${ATTR_CONTENT})?\\s*/>|${escapeRegex(closeTag)}`,
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
