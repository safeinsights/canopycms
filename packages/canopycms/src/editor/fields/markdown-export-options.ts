import type { ToMarkdownOptions } from '@mdxeditor/editor'

/**
 * How the rich editor writes markdown: the style Prettier formats markdown to, so the text it
 * writes for new or edited blocks passes a `prettier --check`. It replaces MDXEditor's default
 * options wholesale, so MDXEditor's own `listItemIndent` is restated. Untouched blocks keep their
 * on-disk text whatever these say (`utils/markdown-body-splice.ts`).
 */
export const MARKDOWN_EXPORT_OPTIONS: ToMarkdownOptions = {
  listItemIndent: 'one',
  bullet: '-',
  emphasis: '_',
  strong: '*',
  rule: '-',
}
