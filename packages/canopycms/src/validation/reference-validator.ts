import path from 'node:path'

import type { ContentIdIndex } from '../content-id-index'
import { extractEntryTypeFromFilename } from '../content-id-index'
import type { FieldConfig, ReferenceFieldConfig } from '../config'
import { isValidId } from '../id'
import { findFieldsByType } from './field-traversal'

export interface ValidationError {
  field: string
  fieldPath: string
  id: string
  error: string
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
}

/**
 * ReferenceValidator validates that referenced content IDs exist and match collection constraints.
 *
 * This class provides validation for:
 * - ID format validation (valid short UUID)
 * - ID existence validation (entry actually exists)
 * - Collection constraint validation (entry is in allowed collections)
 *
 * Usage:
 *   const validator = new ReferenceValidator(idIndex, schema)
 *   const result = await validator.validate(entryData)
 *   if (!result.valid) {
 *     console.error('Validation errors:', result.errors)
 *   }
 */
export class ReferenceValidator {
  /**
   * @param resolveCollection - Resolves a schema-declared collection name
   *   (the documented unprefixed form, e.g. 'posts') to its canonical logical
   *   path (e.g. 'content/posts'), typically `ContentStore.resolveCollectionItem`.
   *   Keeps the write boundary consistent with reference-option loading: any
   *   entry the dropdown offers must also pass validation. Without a resolver,
   *   names are compared as-is against the index's logical collection paths.
   */
  constructor(
    private idIndex: ContentIdIndex,
    private schema: readonly FieldConfig[],
    private resolveCollection?: (name: string) => string | undefined,
  ) {}

  /**
   * Check whether an entry's collection (canonical logical path from the ID
   * index, e.g. 'content/posts') satisfies a field's `collections` constraint
   * (documented unprefixed names, e.g. ['posts']). Subcollections of an
   * allowed collection are allowed.
   */
  private collectionAllowed(entryCollection: string | undefined, allowed: string[]): boolean {
    return allowed.some((col: string) => {
      const canonical = this.resolveCollection?.(col) ?? col
      // Exact match or nested collection match
      return entryCollection === canonical || entryCollection?.startsWith(canonical + '/')
    })
  }

  /**
   * Validate all reference fields in the provided data.
   *
   * @param data - The entry data to validate
   * @returns Validation result with any errors found
   */
  async validate(data: Record<string, unknown>): Promise<ValidationResult> {
    const errors: ValidationError[] = []
    // Use shared field traversal to find all reference fields
    const refContexts = findFieldsByType(this.schema, data, 'reference')
    const refs = refContexts.map((ctx) => ({
      field: ctx.field as ReferenceFieldConfig,
      value: ctx.value as string | string[],
      path: ctx.path,
    }))

    for (const { field, value, path: fieldPath } of refs) {
      const ids = Array.isArray(value) ? value : [value]

      for (const id of ids) {
        // Skip empty values (they're handled by required validation). The
        // editor sends '' when a single-select reference is cleared
        // (ReferenceField coerces Mantine's null to ''), so an empty string
        // means "no reference", not a malformed ID.
        if (id == null || id === '') continue

        // Validate ID format
        if (typeof id !== 'string' || !isValidId(id)) {
          errors.push({
            field: field.name,
            fieldPath,
            id: String(id),
            error: 'Invalid content ID format',
          })
          continue
        }

        // Validate ID exists
        const location = this.idIndex.findById(id)
        if (!location) {
          errors.push({
            field: field.name,
            fieldPath,
            id,
            error: 'Referenced entry does not exist',
          })
          continue
        }

        // Validate location is an entry (not a collection)
        if (location.type !== 'entry') {
          errors.push({
            field: field.name,
            fieldPath,
            id,
            error: 'ID points to a collection, not an entry',
          })
          continue
        }

        // Validate collection constraint
        if (field.collections && field.collections.length > 0) {
          const allowed = this.collectionAllowed(location.collection, field.collections)

          if (!allowed) {
            errors.push({
              field: field.name,
              fieldPath,
              id,
              error: `Entry is in collection "${location.collection}", but only [${field.collections.join(', ')}] are allowed`,
            })
            continue
          }
        }

        // Validate entry type constraint
        if (field.entryTypes && field.entryTypes.length > 0) {
          const entryType = extractEntryTypeFromFilename(path.basename(location.relativePath))
          if (!entryType || !field.entryTypes.includes(entryType)) {
            errors.push({
              field: field.name,
              fieldPath,
              id,
              error: `Entry has type "${entryType ?? 'unknown'}", but only [${field.entryTypes.join(', ')}] are allowed`,
            })
          }
        }
      }
    }

    return { valid: errors.length === 0, errors }
  }

  /**
   * Validate a single reference ID.
   * Useful for validating user input in real-time.
   */
  async validateSingle(id: string, field: ReferenceFieldConfig): Promise<ValidationError | null> {
    // '' means "no reference" (cleared single-select) — see validate().
    if (id === '') return null
    if (!isValidId(id)) {
      return {
        field: field.name,
        fieldPath: field.name,
        id,
        error: 'Invalid content ID format',
      }
    }

    const location = this.idIndex.findById(id)
    if (!location) {
      return {
        field: field.name,
        fieldPath: field.name,
        id,
        error: 'Referenced entry does not exist',
      }
    }

    if (location.type !== 'entry') {
      return {
        field: field.name,
        fieldPath: field.name,
        id,
        error: 'ID points to a collection, not an entry',
      }
    }

    if (field.collections && field.collections.length > 0) {
      const allowed = this.collectionAllowed(location.collection, field.collections)

      if (!allowed) {
        return {
          field: field.name,
          fieldPath: field.name,
          id,
          error: `Entry is in collection "${location.collection}", but only [${field.collections.join(', ')}] are allowed`,
        }
      }
    }

    if (field.entryTypes && field.entryTypes.length > 0) {
      const entryType = extractEntryTypeFromFilename(path.basename(location.relativePath))
      if (!entryType || !field.entryTypes.includes(entryType)) {
        return {
          field: field.name,
          fieldPath: field.name,
          id,
          error: `Entry has type "${entryType ?? 'unknown'}", but only [${field.entryTypes.join(', ')}] are allowed`,
        }
      }
    }

    return null
  }
}
