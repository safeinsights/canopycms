/** GFM's autolink literals (bare `www.`, `http(s)://` and email addresses), by GFM's own parser. */

import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmAutolinkLiteralFromMarkdown } from 'mdast-util-gfm-autolink-literal'
import { gfmAutolinkLiteral } from 'micromark-extension-gfm-autolink-literal'

export { gfmAutolinkLiteral, gfmAutolinkLiteralFromMarkdown }

interface MdNode {
  readonly type: string
  readonly url?: string
  readonly value?: string
  readonly children?: readonly MdNode[]
  readonly position?: {
    readonly start: { readonly offset?: number }
    readonly end: { readonly offset?: number }
  }
}

export interface AutolinkLiteral {
  /** GFM's href: `www.` gains `http://`, an email `mailto:`. */
  readonly url: string
  readonly length: number
}

/** An export asks about a paragraph once per link in it, so recent parses are kept. */
const MAX_CACHED = 16
const cache = new Map<string, ReadonlyMap<number, AutolinkLiteral>>()

/** `text`'s literals by offset. `[a](b)` and `<b>` are none, and lexical text holds neither. */
function literalsIn(text: string): ReadonlyMap<number, AutolinkLiteral> {
  const cached = cache.get(text)
  if (cached) return cached
  const tree: MdNode = fromMarkdown(text, {
    extensions: [gfmAutolinkLiteral()],
    mdastExtensions: [gfmAutolinkLiteralFromMarkdown()],
  })
  const literals = new Map<number, AutolinkLiteral>()
  const pending: MdNode[] = [tree]
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    const [only, ...rest] = node.children ?? []
    if (
      node.type === 'link' &&
      node.url !== undefined &&
      start !== undefined &&
      end !== undefined &&
      rest.length === 0 &&
      only?.type === 'text' &&
      only.value === text.slice(start, end)
    ) {
      literals.set(start, { url: node.url, length: end - start })
    } else {
      pending.push(...(node.children ?? []))
    }
  }
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value ?? '')
  cache.set(text, literals)
  return literals
}

/** The literal GFM reads at `offset` in `text`, if any. */
export function autolinkLiteralAt(text: string, offset: number): AutolinkLiteral | undefined {
  return literalsIn(text).get(offset)
}
