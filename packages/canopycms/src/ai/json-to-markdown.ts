/**
 * Schema-driven entry-to-markdown converter for AI content generation.
 *
 * Converts a single entry's data + schema fields to clean markdown.
 * Handles all CanopyCMS field types including nested objects and blocks.
 */

import type { FieldConfig, ObjectFieldConfig, BlockFieldConfig, SelectFieldConfig } from '../config'
import { flattenGroupFields } from '../utils/flatten-group-fields'
import { stripMdxImports } from './strip-mdx'
import { applyComponentTransforms } from './transform-components'
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
    // For data-only formats (JSON/YAML): full schema-driven conversion
    parts.push(...renderJsonEntry(entry, config, skipFields))
  }

  // Markdown appended by an entry transform (e.g. a folded-in sibling artifact). Computed once
  // upstream, so it flows into the per-entry file, the collection all.md, and bundles alike.
  if (entry.appendedSections) {
    parts.push(entry.appendedSections.trim())
    parts.push('')
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
  const metadataFields = flattenGroupFields(entry.fields).filter(
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

  // Append body — pipeline: stripMdxImports → componentTransforms → bodyTransforms
  if (entry.body) {
    let body = entry.format === 'mdx' ? stripMdxImports(entry.body) : entry.body

    if (config?.componentTransforms && Object.keys(config.componentTransforms).length > 0) {
      body = applyComponentTransforms(body, config.componentTransforms)
    }

    const bodyTransformFn = config?.bodyTransforms?.[entry.entryType]
    if (bodyTransformFn) {
      body = bodyTransformFn(body, entry)
    }

    parts.push(body.trim())
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

  for (const field of flattenGroupFields(entry.fields)) {
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
  if ('list' in field && field.list && Array.isArray(value)) {
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
      return `${heading} ${label}${descriptionLine}\n\n${formatImageMarkdown(value, label)}`

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

  // Arrays of flat records (object items whose subfields are all single-line scalars) render far
  // more compactly — and more scannably for an AI — as a markdown table than as nested ordinal
  // headings. Genuinely nested items (subfields that are lists/objects/blocks/long text) keep the
  // heading-per-item fallback below.
  if (field.type === 'object' && isFlatObjectList(field)) {
    return renderObjectListTable(field, values, label, heading, descriptionLine)
  }

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

/** Subfield types that render to a single line and so fit cleanly in a table cell. */
const FLAT_CELL_TYPES = new Set([
  'string',
  'number',
  'datetime',
  'boolean',
  'select',
  'reference',
  'image',
])

/**
 * True when an object list field's items are flat records — every subfield is a single-line scalar
 * *field type* (no sub-lists, nested objects/blocks, or multi-line text/code types). Such lists
 * render as a table; anything else keeps the nested heading-per-item form. This is a schema-level
 * check: it classifies by declared field type, not by inspecting values (a `string` field whose
 * value happens to be long still qualifies and is collapsed into one cell).
 */
function isFlatObjectList(field: FieldConfig): field is ObjectFieldConfig {
  if (field.type !== 'object') return false
  const subFields = (field as ObjectFieldConfig).fields
  if (!subFields || subFields.length === 0) return false
  return subFields.every((f) => !('list' in f && f.list) && FLAT_CELL_TYPES.has(f.type))
}

/**
 * Render an array of flat object records as a GFM table. Columns are the subfields in schema order;
 * absent values become empty cells; pipes and newlines in cells are escaped.
 */
function renderObjectListTable(
  field: ObjectFieldConfig,
  values: unknown[],
  label: string,
  heading: string,
  descriptionLine: string,
): string {
  const columns = field.fields
  const headerRow = `| ${columns.map((f) => escapeTableCell(f.label || f.name)).join(' | ')} |`
  const separatorRow = `| ${columns.map(() => '---').join(' | ')} |`
  const dataRows = values.map((item) => {
    const record =
      typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {}
    const cells = columns.map((f) => {
      const v = record[f.name]
      if (v === undefined || v === null) return ''
      return escapeTableCell(formatCellValue(f, v))
    })
    return `| ${cells.join(' | ')} |`
  })
  const table = [headerRow, separatorRow, ...dataRows].join('\n')
  return `${heading} ${label}${descriptionLine}\n\n${table}`
}

/** Render a single scalar subfield value to its one-line table-cell form. */
function formatCellValue(field: FieldConfig, value: unknown): string {
  switch (field.type) {
    case 'boolean':
      return value ? 'Yes' : 'No'
    case 'reference':
      return formatReference(value)
    case 'select':
      return Array.isArray(value)
        ? value.map((v) => resolveSelectLabel(field as SelectFieldConfig, v)).join(', ')
        : resolveSelectLabel(field as SelectFieldConfig, value)
    case 'image':
      // Match the standalone image rendering (renderField) so a table cell stays an image
      // reference; unlike the standalone case, alt has no label fallback here (kept terse —
      // the column header already carries the label for every row).
      return formatImageMarkdown(value, '')
    default:
      return String(value)
  }
}

/** Escape a value for a GFM table cell: backslashes and pipes are escaped, newlines collapsed. */
function escapeTableCell(value: string): string {
  // Escape backslashes first so an already-present backslash can't consume the pipe escape we add
  // (source `a\|b` must become `a\\\|b`, not `a\\|b` — the latter leaves `|` as a column delimiter).
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n+/g, ' ')
    .trim()
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

/** True for a plain object (not null, not an array) with a string `src`. */
function isImageValueLike(value: unknown): value is { src: string; alt?: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).src === 'string'
  )
}

/**
 * Sanitize `alt` for the `[...]` link-text span of `![alt](src)`. `alt` is
 * user free-text, so a crafted value like `x](/a) [pwn](https://evil.com)`
 * could otherwise inject a second, attacker-chosen link/image right next to
 * the intended one. Strips (rather than backslash-escapes) `[`, `]`, and any
 * backslash: alt is a human-readable description, so losing a stray literal
 * bracket from it is a non-issue, and stripping sidesteps a real composability
 * bug backslash-escaping would have - `renderObjectListTable`'s
 * `escapeTableCell` blindly DOUBLES every backslash in a cell's final text
 * (to protect its own `|`-splitting), which would silently unescape a
 * `\[`/`\]` produced here the moment this markdown lands in a table cell
 * (formatCellValue's image case, below). Newlines collapse to spaces for the
 * same "can't break out of the link-text span" reason.
 */
function sanitizeMarkdownAltText(text: string): string {
  return text
    .replace(/[[\]\\]/g, '')
    .replace(/\r?\n+/g, ' ')
    .trim()
}

/**
 * Percent-encode the handful of characters that would otherwise break a
 * bare, unbracketed markdown link destination `(src)`: a literal `)` closes
 * the destination early, and a space or `(` confuses where it ends. Percent-
 * encoding (rather than wrapping in `<...>` or backslash-escaping) is used
 * deliberately: it introduces no backslash of its own, so - like
 * `sanitizeMarkdownAltText` above - it survives `escapeTableCell`'s blind
 * backslash-doubling unchanged when this lands in a table cell.
 */
function encodeMarkdownLinkDestination(src: string): string {
  return src
    .replace(/[\r\n]+/g, '')
    .replace(/ /g, '%20')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
}

/**
 * Format an `image` field value as markdown image syntax: `![alt](src)`.
 * Uses the value's own `alt` when non-empty, otherwise `altFallback`. Both
 * `alt` and `src` are sanitized for their respective markdown contexts (see
 * `sanitizeMarkdownAltText`/`encodeMarkdownLinkDestination`) since `alt` is
 * user free-text and `src` may contain characters unsafe in a bare link
 * destination. Malformed values (not a `{ src, alt }`-shaped object — e.g. a
 * legacy bare URL string) degrade to a plain string, matching how neighboring
 * field serializers (e.g. renderObjectField, formatReference) handle
 * unexpected shapes.
 */
function formatImageMarkdown(value: unknown, altFallback: string): string {
  if (!isImageValueLike(value)) {
    return String(value)
  }
  const alt = typeof value.alt === 'string' && value.alt.trim() !== '' ? value.alt : altFallback
  return `![${sanitizeMarkdownAltText(alt)}](${encodeMarkdownLinkDestination(value.src)})`
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
  // Without this, an `image` field falls through to `String(value)` below,
  // which stringifies the structured `{ src, alt }` value object as the
  // useless literal text "[object Object]" - hit by MD/MDX frontmatter
  // metadata fields (renderMarkdownEntry) and top-level `list: true` image
  // fields (renderListField's primitive-list branch), both of which call
  // this function directly.
  if (field.type === 'image') return formatImageMarkdown(value, field.label || field.name)
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
