/**
 * The md/mdx body parser the save path and the merge engine share, so both read a body the same
 * way. Dependency-free of node built-ins: the merge engine runs in the browser bundle too.
 */

import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mdxFromMarkdown } from 'mdast-util-mdx'
import { gfm } from 'micromark-extension-gfm'
import { mdxjs } from 'micromark-extension-mdxjs'

import { createDebugLogger } from './debug'
import { getErrorMessage } from './error'

const log = createDebugLogger({ prefix: 'MarkdownParse' })

export type MarkdownBodyFormat = 'md' | 'mdx'

export type MarkdownRoot = ReturnType<typeof fromMarkdown>

/** `text`'s mdast with GFM, and MDX for `mdx`; undefined when it does not parse. */
export function parseMarkdownBody(
  text: string,
  format: MarkdownBodyFormat,
): MarkdownRoot | undefined {
  try {
    return format === 'mdx'
      ? fromMarkdown(text, {
          extensions: [gfm(), mdxjs()],
          mdastExtensions: [gfmFromMarkdown(), mdxFromMarkdown()],
        })
      : fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  } catch (err: unknown) {
    log.debug('markdown-parse', 'body does not parse', { error: getErrorMessage(err) })
    return undefined
  }
}
