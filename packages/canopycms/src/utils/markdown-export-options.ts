/**
 * The style every markdown body is written in: Prettier's markers. The rich editor exports with
 * it, and a save restyles edited blocks to it whichever editor mode produced them
 * (`markdown-restyle.ts`). MDXEditor's prop replaces its defaults, so `listItemIndent` is
 * restated.
 */
export const MARKDOWN_EXPORT_OPTIONS = {
  listItemIndent: 'one',
  bullet: '-',
  emphasis: '_',
  strong: '*',
  rule: '-',
} as const
