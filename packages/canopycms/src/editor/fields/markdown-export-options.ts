import type { ToMarkdownOptions } from '@mdxeditor/editor'

/**
 * How the rich editor writes markdown: Prettier's list, emphasis, strong and rule markers, so new
 * and edited blocks match Prettier on those (its escaping still differs: `a\_b`, which Prettier
 * writes `a_b`). It replaces MDXEditor's default options wholesale (`MDXEditor.js`'s
 * `props.toMarkdownOptions ?? DEFAULT_MARKDOWN_OPTIONS`), so its `listItemIndent` is restated.
 * Untouched blocks keep their on-disk text whatever these say (`utils/markdown-body-splice.ts`).
 */
export const MARKDOWN_EXPORT_OPTIONS: ToMarkdownOptions = {
  listItemIndent: 'one',
  bullet: '-',
  emphasis: '_',
  strong: '*',
  rule: '-',
}
