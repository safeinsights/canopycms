import type { Options } from 'mdast-util-to-markdown'

/**
 * The style every markdown body is written in: Prettier's markers. The rich editor exports with
 * it, and a save re-serialises edited blocks with it whichever editor mode produced them
 * (`markdown-body-splice.ts`). MDXEditor's prop replaces its defaults, so `listItemIndent` is
 * restated.
 */
export const MARKDOWN_EXPORT_OPTIONS: Options = {
  listItemIndent: 'one',
  bullet: '-',
  emphasis: '_',
  strong: '*',
  rule: '-',
}
