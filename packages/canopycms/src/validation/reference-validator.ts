import type { ContentIdIndex } from '../content-id-index'
import type { FieldConfig, ReferenceFieldConfig } from '../config'
import { isValidId } from '../id'

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

interface ReferenceInstance {
  field: ReferenceFieldConfig
  value: string | string[]
  path: string
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
    private schema: FieldConfig[]
  ) {}

  /**
   * Validate all reference fields in the provided data.
   *
   * @param data - The entry data to validate
   * @returns Validation result with any errors found
   */
  async validate(data: Record<string, unknown>): Promise<ValidationResult> {
    const errors: ValidationError[] = []
    const refs = this.extractReferences(this.schema, data)

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
            error: 'Invalid content ID format'
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
            error: 'Referenced entry does not exist'
          })
          continue
        }

        // Validate location is an entry (not a collection)
        if (location.type !== 'entry') {
          errors.push({
            field: field.name,
            fieldPath: path,
            id,
            error: 'ID points to a collection, not an entry'
          })
          continue
        }

        // Validate collection constraint
        if (field.collections && field.collections.length > 0) {
          const allowed = field.collections.some((col: string) => {
            // Exact match or nested collection match
            return (
              location.collection === col ||
              location.collection?.startsWith(col + '/')
            )
          })

          if (!allowed) {
            errors.push({
              field: field.name,
              fieldPath: path,
              id,
              error: `Entry is in collection "${location.collection}", but only [${field.collections.join(', ')}] are allowed`
            })
          }
        }
      }
    }

    return { valid: errors.length === 0, errors }
  }

  /**
   * Extract all reference field instances from data, respecting the schema structure.
   *
   * This handles nested objects, arrays, and block fields.
   */
  private extractReferences(
    fields: FieldConfig[],
    data: Record<string, unknown>,
    pathPrefix = ''
  ): ReferenceInstance[] {
    const refs: ReferenceInstance[] = []

    for (const field of fields) {
      const fieldPath = pathPrefix ? `${pathPrefix}.${field.name}` : field.name
      const value = data[field.name]

      if (value === undefined || value === null) continue

      if (field.type === 'reference') {
        refs.push({
          field: field as ReferenceFieldConfig,
          value: value as string | string[],
          path: fieldPath
        })
      } else if (field.type === 'object') {
        // Recurse into object fields
        const objectField = field as any
        if (objectField.fields && typeof value === 'object' && !Array.isArray(value)) {
          refs.push(
            ...this.extractReferences(
              objectField.fields,
              value as Record<string, unknown>,
              fieldPath
            )
          )
        }
      } else if (field.type === 'block') {
        // Handle block fields (arrays of objects with different schemas)
        const blockField = field as any
        if (Array.isArray(value)) {
          value.forEach((item, index) => {
            if (typeof item === 'object' && item !== null) {
              const blockType = (item as any)._type
              const blockDef = blockField.blocks?.find((b: any) => b.name === blockType)
              if (blockDef && blockDef.fields) {
                refs.push(
                  ...this.extractReferences(
                    blockDef.fields,
                    item as Record<string, unknown>,
                    `${fieldPath}[${index}]`
                  )
                )
              }
            }
          })
        }
      } else if (field.type === 'array') {
        // Handle array fields
        const arrayField = field as any
        if (Array.isArray(value) && arrayField.of) {
          // If the array contains objects/blocks with fields, recurse
          if (arrayField.of.type === 'object' && arrayField.of.fields) {
            value.forEach((item, index) => {
              if (typeof item === 'object' && item !== null) {
                refs.push(
                  ...this.extractReferences(
                    arrayField.of.fields,
                    item as Record<string, unknown>,
                    `${fieldPath}[${index}]`
                  )
                )
              }
            })
          }
        }
      }
    }

    return refs
  }

  /**
   * Validate a single reference ID.
   * Useful for validating user input in real-time.
   */
  async validateSingle(
    id: string,
    field: ReferenceFieldConfig
  ): Promise<ValidationError | null> {
    if (!isValidId(id)) {
      return {
        field: field.name,
        fieldPath: field.name,
        id,
        error: 'Invalid content ID format'
      }
    }

    const location = this.idIndex.findById(id)
    if (!location) {
      return {
        field: field.name,
        fieldPath: field.name,
        id,
        error: 'Referenced entry does not exist'
      }
    }

    if (location.type !== 'entry') {
      return {
        field: field.name,
        fieldPath: field.name,
        id,
        error: 'ID points to a collection, not an entry'
      }
    }

    if (field.collections && field.collections.length > 0) {
      const allowed = field.collections.some((col: string) => {
        return (
          location.collection === col ||
          location.collection?.startsWith(col + '/')
        )
      })

      if (!allowed) {
        return {
          field: field.name,
          fieldPath: field.name,
          id,
          error: `Entry is in collection "${location.collection}", but only [${field.collections.join(', ')}] are allowed`
        }
      }
    }

    return null
  }
}
