import type { FieldConfig, InlineGroupFieldConfig } from '../config'

function isGroupField(field: FieldConfig): field is InlineGroupFieldConfig {
  return field.type === 'group'
}

/**
 * Value of the field marked `isTitle: true`, or undefined when there is none or it is not a
 * string. Recurses into object fields, so a nested title (`hero.title`) is found.
 * @internal Exported for tests.
 */
export function extractTitleFromSchema(
  fields: readonly FieldConfig[],
  data: Record<string, unknown>,
): string | undefined {
  return findTitleValue(fields, data)
}

function findTitleValue(
  fields: readonly FieldConfig[],
  data: Record<string, unknown>,
): string | undefined {
  for (const field of fields) {
    // Inline groups are transparent — recurse at the same data level
    if (isGroupField(field)) {
      const result = findTitleValue(field.fields, data)
      if (result !== undefined) return result
    } else if ('isTitle' in field && field.isTitle) {
      const value = data[field.name]
      return typeof value === 'string' ? value : undefined
    } else if (field.type === 'object' && 'fields' in field && field.fields && !field.list) {
      // Recurse into non-list object fields (list objects can't provide a single title value)
      const nested = data[field.name]
      if (nested != null && typeof nested === 'object' && !Array.isArray(nested)) {
        const result = findTitleValue(field.fields, nested as Record<string, unknown>)
        if (result !== undefined) return result
      }
    }
  }
  return undefined
}

/**
 * Convert a slug like "my-cool-page" to "My Cool Page".
 * @internal Exported for tests.
 */
export function humanizeSlug(slug: string): string {
  return slug
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

/**
 * Display title for an entry, by fallback chain: schema-marked isTitle field, then `data.title`
 * or `data.name`, then the entry type label, then the humanized slug, then "Untitled".
 *
 * Client-safe — its only dependency on `../config` is type-only — and re-exported from both
 * `canopycms/server` and the root `canopycms` entry, so adopter client code can import it.
 */
export function resolveEntryTitle(
  data: Record<string, unknown>,
  options?: {
    schema?: readonly FieldConfig[]
    entryTypeLabel?: string
    slug?: string
  },
): string {
  if (options?.schema) {
    const schemaTitle = extractTitleFromSchema(options.schema, data)
    if (schemaTitle) return schemaTitle
  }
  const title = data.title ?? data.name
  if (typeof title === 'string') return title
  if (options?.entryTypeLabel) return options.entryTypeLabel
  return options?.slug ? humanizeSlug(options.slug) : 'Untitled'
}

/**
 * Count fields marked `isTitle: true`, recursing into objects but skipping `list: true` ones,
 * whose array values runtime title extraction cannot resolve. Validation allows at most one.
 */
export function countTitleFields(fields: readonly FieldConfig[]): number {
  let count = 0
  for (const field of fields) {
    if (isGroupField(field)) {
      count += countTitleFields(field.fields)
    } else {
      if ('isTitle' in field && field.isTitle) count++
      if (field.type === 'object' && 'fields' in field && field.fields && !field.list) {
        count += countTitleFields(field.fields)
      }
    }
  }
  return count
}

/**
 * Dotted paths of isTitle fields whose type is not `string`. Skips `list: true` objects —
 * `findTitleFieldsInLists` catches those.
 */
export function findInvalidTitleFields(
  fields: readonly FieldConfig[],
  parentPath?: string,
): string[] {
  const invalid: string[] = []
  for (const field of fields) {
    if (isGroupField(field)) {
      invalid.push(...findInvalidTitleFields(field.fields, parentPath))
    } else {
      const fieldPath = parentPath ? `${parentPath}.${field.name}` : field.name
      if ('isTitle' in field && field.isTitle && field.type !== 'string') {
        invalid.push(fieldPath)
      }
      if (field.type === 'object' && 'fields' in field && field.fields && !field.list) {
        invalid.push(...findInvalidTitleFields(field.fields, fieldPath))
      }
    }
  }
  return invalid
}

/** Dotted paths of isTitle fields inside `list: true` objects, where they can never resolve. */
export function findTitleFieldsInLists(
  fields: readonly FieldConfig[],
  parentPath?: string,
): string[] {
  const found: string[] = []
  for (const field of fields) {
    if (isGroupField(field)) {
      found.push(...findTitleFieldsInLists(field.fields, parentPath))
    } else {
      const fieldPath = parentPath ? `${parentPath}.${field.name}` : field.name
      if (field.type === 'object' && 'fields' in field && field.fields) {
        if (field.list) {
          found.push(...collectAllTitleFields(field.fields, fieldPath))
        } else {
          found.push(...findTitleFieldsInLists(field.fields, fieldPath))
        }
      }
    }
  }
  return found
}

/** Every isTitle field below this point, for the list context where all of them are invalid. */
function collectAllTitleFields(fields: readonly FieldConfig[], parentPath: string): string[] {
  const found: string[] = []
  for (const field of fields) {
    if (isGroupField(field)) {
      // Inline groups are transparent — recurse at the same data level (no new path segment)
      found.push(...collectAllTitleFields(field.fields, parentPath))
    } else {
      const fieldPath = `${parentPath}.${field.name}`
      if ('isTitle' in field && field.isTitle) found.push(fieldPath)
      if (field.type === 'object' && 'fields' in field && field.fields) {
        found.push(...collectAllTitleFields(field.fields, fieldPath))
      }
    }
  }
  return found
}
