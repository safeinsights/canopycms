/** GFM's autolink literals (bare `www.`, `http(s)://` and email addresses), by GFM's own parser. */

import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmAutolinkLiteralFromMarkdown } from 'mdast-util-gfm-autolink-literal'
import { gfmAutolinkLiteral } from 'micromark-extension-gfm-autolink-literal'

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

/**
 * The literal GFM reads at `offset` in `text`, if any. `[a](b)` and `<b>` are no literal: the
 * text is lexical's, which holds no markdown syntax.
 */
export function autolinkLiteralAt(text: string, offset: number): AutolinkLiteral | undefined {
  const tree: MdNode = fromMarkdown(text, {
    extensions: [gfmAutolinkLiteral()],
    mdastExtensions: [gfmAutolinkLiteralFromMarkdown()],
  })
  const pending: MdNode[] = [tree]
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (node.type === 'link' && start === offset && end !== undefined) {
      const [only, ...rest] = node.children ?? []
      const literal =
        rest.length === 0 && only?.type === 'text' && only.value === text.slice(start, end)
      return literal && node.url !== undefined ? { url: node.url, length: end - start } : undefined
    }
    pending.push(...(node.children ?? []))
  }
  return undefined
}
