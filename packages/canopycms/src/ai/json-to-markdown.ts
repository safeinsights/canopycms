/**
 * Schema-driven entry-to-markdown converter for AI content generation.
 *
 * Converts a single entry's data + schema fields to clean markdown.
 * Handles all CanopyCMS field types including nested objects and blocks.
 */

import type { FieldConfig, ObjectFieldConfig, BlockFieldConfig, SelectFieldConfig } from '../config'
import type { AIEntry, AIContentConfig } from './types'

/**
 * Convert an entry to clean markdown suitable for AI consumption.
 *
 * For MD/MDX entries: renders frontmatter fields as metadata, appends body verbatim.
 * For JSON entries: full schema-driven conversion of all fields.
 */
export function entryToMarkdown(entry: AIEntry, config?: AIContentConfig): string {
  const parts: string[] = []

  // Entry header with YAML-style frontmatter
  parts.push('---')
  if (entry.data.title) {
    parts.push(`title: ${yamlValue(String(entry.data.title))}`)
  }
  parts.push(`slug: ${yamlValue(entry.slug)}`)
  parts.push(`collection: ${yamlValue(entry.collection)}`)
  parts.push(`type: ${yamlValue(entry.entryType)}`)
  parts.push('---')
  parts.push('')

  // Fields already in frontmatter — skip from body rendering to avoid duplication
  const skipFields = new Set<string>()
  if (entry.data.title) skipFields.add('title')

  if (entry.format === 'md' || entry.format === 'mdx') {
    // For MD/MDX: render non-body fields as metadata, then body verbatim
    parts.push(...renderMarkdownEntry(entry, config, skipFields))
  } else {
    // For JSON: full schema-driven conversion
    parts.push(...renderJsonEntry(entry, config, skipFields))
  }

  return parts.join('\n')
}

/**
 * Render a MD/MDX entry: metadata fields as a section, body verbatim.
 */
function renderMarkdownEntry(
  entry: AIEntry,
  config: AIContentConfig | undefined,
  skipFields: Set<string>,
): string[] {
  const parts: string[] = []

  // Render frontmatter fields (excluding body-like fields and already-rendered fields)
  const bodyFieldTypes = new Set(['rich-text', 'markdown', 'mdx'])
  const metadataFields = entry.fields.filter(
    (f) => !bodyFieldTypes.has(f.type) && !skipFields.has(f.name),
  )

  for (const field of metadataFields) {
    const value = entry.data[field.name]
    if (value === undefined || value === null) continue

    // Check for field transform
    const transformed = applyFieldTransform(entry, field, value, config)
    if (transformed !== undefined) {
      parts.push(transformed)
      parts.push('')
      continue
    }

    // Simple inline rendering for metadata
    const label = field.label || field.name
    parts.push(`**${label}:** ${formatInlineValue(field, value)}`)
  }

  if (parts.length > 0) {
    parts.push('')
  }

  // Append body verbatim
  if (entry.body) {
    parts.push(entry.body.trim())
    parts.push('')
  }

  return parts
}

/**
 * Render a JSON entry: full schema-driven conversion of all fields.
 */
function renderJsonEntry(
  entry: AIEntry,
  config: AIContentConfig | undefined,
  skipFields: Set<string>,
): string[] {
  const parts: string[] = []

  for (const field of entry.fields) {
    if (skipFields.has(field.name)) continue
    const value = entry.data[field.name]
    if (value === undefined || value === null) continue

    const rendered = renderField(field, value, 2, entry, config)
    if (rendered) {
      parts.push(rendered)
      parts.push('')
    }
  }

  return parts
}

/**
 * Render a single field to markdown.
 *
 * @param field - Field configuration from schema
 * @param value - The field's value
 * @param depth - Heading depth (2 = ##, 3 = ###, etc.)
 * @param entry - The parent entry (for transform lookups)
 * @param config - AI content config (for field transforms)
 */
function renderField(
  field: FieldConfig,
  value: unknown,
  depth: number,
  entry: AIEntry,
  config?: AIContentConfig,
): string {
  // Check for field transform override
  const transformed = applyFieldTransform(entry, field, value, config)
  if (transformed !== undefined) {
    return transformed
  }

  const label = field.label || field.name
  const heading = '#'.repeat(Math.min(depth, 6))
  const descriptionLine =
    'description' in field && field.description ? `\n\n*${field.description}*` : ''

  // Handle list fields
  if (field.list && Array.isArray(value)) {
    return renderListField(field, value, depth, label, heading, descriptionLine, entry, config)
  }

  switch (field.type) {
    case 'string':
    case 'number':
    case 'datetime':
      return `${heading} ${label}${descriptionLine}\n\n${String(value)}`

    case 'boolean':
      return `${heading} ${label}${descriptionLine}\n\n${value ? 'Yes' : 'No'}`

    case 'rich-text':
    case 'markdown':
    case 'mdx':
      return `${heading} ${label}${descriptionLine}\n\n${String(value)}`

    case 'image':
      return `${heading} ${label}${descriptionLine}\n\n![${label}](${String(value)})`

    case 'code':
      return `${heading} ${label}${descriptionLine}\n\n\`\`\`\n${String(value)}\n\`\`\``

    case 'select':
      return renderSelectField(field as SelectFieldConfig, value, heading, label, descriptionLine)

    case 'reference':
      return renderReferenceField(value, heading, label, descriptionLine)

    case 'object':
      return renderObjectField(
        field as ObjectFieldConfig,
        value,
        depth,
        heading,
        label,
        descriptionLine,
        entry,
        config,
      )

    case 'block':
      return renderBlockField(
        field as BlockFieldConfig,
        value,
        depth,
        heading,
        label,
        descriptionLine,
        entry,
        config,
      )

    default:
      // Custom or unknown field type — render as string
      return `${heading} ${label}${descriptionLine}\n\n${String(value)}`
  }
}

/**
 * Render a list field (field with list: true).
 */
function renderListField(
  field: FieldConfig,
  values: unknown[],
  depth: number,
  label: string,
  heading: string,
  descriptionLine: string,
  entry: AIEntry,
  config?: AIContentConfig,
): string {
  if (values.length === 0) return ''

  const isComplex = field.type === 'object' || field.type === 'block'

  if (isComplex) {
    // For complex types, render each item as a subsection
    const items = values
      .map((item, i) => {
        const itemLabel = `${label} ${i + 1}`
        const itemHeading = '#'.repeat(Math.min(depth + 1, 6))
        if (field.type === 'object' && typeof item === 'object' && item !== null) {
          const objectField = field as ObjectFieldConfig
          const subFields = objectField.fields
            .map((f) => {
              const v = (item as Record<string, unknown>)[f.name]
              if (v === undefined || v === null) return ''
              return renderField(f, v, depth + 2, entry, config)
            })
            .filter(Boolean)
          return `${itemHeading} ${itemLabel}\n\n${subFields.join('\n\n')}`
        }
        return `${itemHeading} ${itemLabel}\n\n${String(item)}`
      })
      .filter(Boolean)
    return `${heading} ${label}${descriptionLine}\n\n${items.join('\n\n')}`
  }

  // For primitive types, render as markdown list
  const items = values.map((v) => `- ${formatInlineValue(field, v)}`).join('\n')
  return `${heading} ${label}${descriptionLine}\n\n${items}`
}

/**
 * Render a select field.
 */
function renderSelectField(
  field: SelectFieldConfig,
  value: unknown,
  heading: string,
  label: string,
  descriptionLine: string,
): string {
  if (Array.isArray(value)) {
    return `${heading} ${label}${descriptionLine}\n\n${value.map((v) => resolveSelectLabel(field, v)).join(', ')}`
  }
  return `${heading} ${label}${descriptionLine}\n\n${resolveSelectLabel(field, value)}`
}

/**
 * Resolve a select value to its display label.
 */
function resolveSelectLabel(field: SelectFieldConfig, value: unknown): string {
  const strValue = String(value)
  for (const opt of field.options) {
    if (typeof opt === 'string') {
      if (opt === strValue) return opt
    } else {
      if (opt.value === strValue) return opt.label
    }
  }
  return strValue
}

/**
 * Render a reference field.
 */
function renderReferenceField(
  value: unknown,
  heading: string,
  label: string,
  descriptionLine: string,
): string {
  if (Array.isArray(value)) {
    const items = value.map((v) => `- ${formatReference(v)}`).join('\n')
    return `${heading} ${label}${descriptionLine}\n\n${items}`
  }
  return `${heading} ${label}${descriptionLine}\n\n${formatReference(value)}`
}

/**
 * Format a single reference value.
 * References may be resolved (objects with data) or unresolved (string IDs).
 */
function formatReference(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    const ref = value as Record<string, unknown>
    // Resolved reference — use title, name, or slug
    const display = ref.title || ref.name || ref.slug || ref.id
    if (display) return String(display)
  }
  // Unresolved — raw ID or string
  return String(value)
}

/**
 * Render an object field with nested fields.
 */
function renderObjectField(
  field: ObjectFieldConfig,
  value: unknown,
  depth: number,
  heading: string,
  label: string,
  descriptionLine: string,
  entry: AIEntry,
  config?: AIContentConfig,
): string {
  if (typeof value !== 'object' || value === null) {
    return `${heading} ${label}${descriptionLine}\n\n${String(value)}`
  }

  const obj = value as Record<string, unknown>
  const subFields = field.fields
    .map((f) => {
      const v = obj[f.name]
      if (v === undefined || v === null) return ''
      return renderField(f, v, depth + 1, entry, config)
    })
    .filter(Boolean)

  if (subFields.length === 0) return ''
  return `${heading} ${label}${descriptionLine}\n\n${subFields.join('\n\n')}`
}

/**
 * Render a block field (array of typed block items).
 */
function renderBlockField(
  field: BlockFieldConfig,
  value: unknown,
  depth: number,
  heading: string,
  label: string,
  descriptionLine: string,
  entry: AIEntry,
  config?: AIContentConfig,
): string {
  if (!Array.isArray(value)) return ''

  const items = value
    .map((item) => {
      if (typeof item !== 'object' || item === null) return ''
      const blockItem = item as Record<string, unknown>

      // Block items use _type (field traversal) or template (ContentStore)
      const templateName = (blockItem._type || blockItem.template) as string | undefined
      if (!templateName) return ''

      const template = field.templates.find((t) => t.name === templateName)
      if (!template) return ''

      const blockHeading = '#'.repeat(Math.min(depth + 1, 6))
      const blockLabel = template.label || template.name
      const blockFields = template.fields
        .map((f) => {
          const v = blockItem[f.name] ?? (blockItem.value as Record<string, unknown>)?.[f.name]
          if (v === undefined || v === null) return ''
          return renderField(f, v, depth + 2, entry, config)
        })
        .filter(Boolean)

      if (blockFields.length === 0) return ''
      return `${blockHeading} ${blockLabel}\n\n${blockFields.join('\n\n')}`
    })
    .filter(Boolean)

  if (items.length === 0) return ''
  return `${heading} ${label}${descriptionLine}\n\n${items.join('\n\n')}`
}

/**
 * Apply a field transform if one exists for this entry type + field name.
 * Returns undefined if no transform applies.
 */
function applyFieldTransform(
  entry: AIEntry,
  field: FieldConfig,
  value: unknown,
  config?: AIContentConfig,
): string | undefined {
  if (!config?.fieldTransforms) return undefined
  const typeTransforms = config.fieldTransforms[entry.entryType]
  if (!typeTransforms) return undefined
  const fn = typeTransforms[field.name]
  if (!fn) return undefined
  return fn(value, field)
}

/**
 * Format a value for inline display (metadata lines, list items).
 */
function formatInlineValue(field: FieldConfig, value: unknown): string {
  if (field.type === 'boolean') return value ? 'Yes' : 'No'
  if (field.type === 'reference') return formatReference(value)
  return String(value)
}

/**
 * Escape a value for YAML frontmatter.
 * Wraps in quotes if value contains special characters.
 */
function yamlValue(value: string): string {
  if (/[:#{}[\],&*?|>!%@`]/.test(value) || value.includes('\n')) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return value
}
