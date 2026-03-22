import type { ContentIdIndex } from '../content-id-index'
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
  constructor(
    private idIndex: ContentIdIndex,
    private schema: readonly FieldConfig[],
  ) {}

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

    for (const { field, value, path } of refs) {
      const ids = Array.isArray(value) ? value : [value]

      for (const id of ids) {
        // Skip null/undefined values (they're handled by required validation)
        if (id == null) continue

        // Validate ID format
        if (typeof id !== 'string' || !isValidId(id)) {
          errors.push({
            field: field.name,
            fieldPath: path,
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
            fieldPath: path,
            id,
            error: 'Referenced entry does not exist',
          })
          continue
        }

        // Validate location is an entry (not a collection)
        if (location.type !== 'entry') {
          errors.push({
            field: field.name,
            fieldPath: path,
            id,
            error: 'ID points to a collection, not an entry',
          })
          continue
        }

        // Validate collection constraint
        if (field.collections && field.collections.length > 0) {
          const allowed = field.collections.some((col: string) => {
            // Exact match or nested collection match
            return location.collection === col || location.collection?.startsWith(col + '/')
          })

          if (!allowed) {
            errors.push({
              field: field.name,
              fieldPath: path,
              id,
              error: `Entry is in collection "${location.collection}", but only [${field.collections.join(', ')}] are allowed`,
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
      const allowed = field.collections.some((col: string) => {
        return location.collection === col || location.collection?.startsWith(col + '/')
      })

      if (!allowed) {
        return {
          field: field.name,
          fieldPath: field.name,
          id,
          error: `Entry is in collection "${location.collection}", but only [${field.collections.join(', ')}] are allowed`,
        }
      }
    }

    return null
  }
}
