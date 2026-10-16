import type { ToMarkdownOptions } from '@mdxeditor/editor'

// Prettier's markers. The prop replaces MDXEditor's defaults, so `listItemIndent` is restated.
export const MARKDOWN_EXPORT_OPTIONS: ToMarkdownOptions = {
  listItemIndent: 'one',
  bullet: '-',
  emphasis: '_',
  strong: '*',
  rule: '-',
}
