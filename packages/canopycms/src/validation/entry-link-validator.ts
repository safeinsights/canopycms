/**
 * EntryLinkValidator validates that entry:ID patterns in body/markdown fields
 * reference existing entries.
 *
 * Returns warnings (not errors) — saves are never blocked by broken entry links.
 * This parallels ReferenceValidator but operates on inline links in text content
 * rather than structured reference fields.
 */

import type { ContentIdIndex } from '../content-id-index'
import type { FieldConfig } from '../config'
import { extractEntryLinkIds } from '../entry-link-resolver'
import { findFieldsByType } from './field-traversal'

export interface EntryLinkWarning {
  field: string
  fieldPath: string
  id: string
  message: string
}

export interface EntryLinkValidationResult {
  warnings: EntryLinkWarning[]
}

/**
 * Validate entry links in body/markdown/mdx fields of the provided data.
 *
 * Scans all markdown, mdx, and rich-text fields for entry:ID patterns
 * and checks that each referenced ID exists in the content index.
 */
export function validateEntryLinks(
  data: Record<string, unknown>,
  schema: readonly FieldConfig[],
  idIndex: ContentIdIndex,
  bodyContent?: string,
): EntryLinkValidationResult {
  const warnings: EntryLinkWarning[] = []

  // Check body content (for md/mdx entries, body is separate from data)
  if (bodyContent) {
    checkText(bodyContent, 'body', 'body', idIndex, warnings)
  }

  // Check markdown/mdx/rich-text fields in structured data
  const markdownTypes = ['markdown', 'mdx', 'rich-text'] as const
  for (const fieldType of markdownTypes) {
    const contexts = findFieldsByType(schema, data, fieldType)
    for (const ctx of contexts) {
      if (typeof ctx.value === 'string' && ctx.value) {
        checkText(ctx.value, ctx.field.name, ctx.path, idIndex, warnings)
      }
    }
  }

  return { warnings }
}

function checkText(
  text: string,
  fieldName: string,
  fieldPath: string,
  idIndex: ContentIdIndex,
  warnings: EntryLinkWarning[],
): void {
  const links = extractEntryLinkIds(text)

  for (const link of links) {
    const location = idIndex.findById(link.id)
    if (!location || location.type !== 'entry') {
      warnings.push({
        field: fieldName,
        fieldPath,
        id: link.id,
        message: `Entry link target not found: entry:${link.id}`,
      })
    }
  }
}
