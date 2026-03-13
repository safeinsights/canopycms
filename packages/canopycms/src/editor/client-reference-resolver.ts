import type { EntrySchema, FieldConfig, ReferenceFieldConfig } from '../config'
import type { FormValue } from './FormRenderer'
import { createApiClient } from '../api/client'

/**
 * Client-side utility for incrementally resolving reference fields in form data.
 * Used by FormRenderer to transform draft data before sending to preview.
 */

/**
 * Find which fields changed between two form values.
 * Only returns top-level field configs for fields that changed.
 */
export function findChangedFields(
  prevValue: FormValue,
  currentValue: FormValue,
  schema: EntrySchema
): FieldConfig[] {
  const changed: FieldConfig[] = []

  for (const field of schema) {
    const prevFieldValue = prevValue[field.name]
    const currentFieldValue = currentValue[field.name]

    // Deep equality check for objects and arrays
    if (JSON.stringify(prevFieldValue) !== JSON.stringify(currentFieldValue)) {
      changed.push(field)
    }
  }

  return changed
}

/**
 * Resolve changed references incrementally.
 * Only resolves reference fields that have changed.
 * Uses cache to avoid duplicate API calls.
 */
export async function resolveChangedReferences(
  prevValue: FormValue,
  currentValue: FormValue,
  schema: EntrySchema,
  branch: string,
  cache: Map<string, any>
): Promise<Partial<FormValue>> {
  const changedFields = findChangedFields(prevValue, currentValue, schema)
  const updates: Partial<FormValue> = {}

  for (const field of changedFields) {
    if (field.type === 'reference') {
      const refField = field as ReferenceFieldConfig
      const fieldValue = currentValue[field.name]

      // Resolve this field's value
      if (refField.list && Array.isArray(fieldValue)) {
        // List of references
        const resolved = await Promise.all(
          fieldValue.map(id => resolveReferenceId(id, branch, cache))
        )
        updates[field.name] = resolved
      } else if (fieldValue) {
        // Single reference
        const resolved = await resolveReferenceId(fieldValue, branch, cache)
        updates[field.name] = resolved
      }
    }
  }

  return updates
}

/**
 * Resolve a single reference ID to full object.
 * Checks cache first, then makes API call if needed.
 * Returns original ID if resolution fails.
 */
async function resolveReferenceId(
  id: unknown,
  branch: string,
  cache: Map<string, any>
): Promise<any> {
  // Only resolve string IDs
  if (typeof id !== 'string') {
    return id
  }

  // Check if already resolved (has __typename or other object properties)
  if (typeof id === 'object' && id !== null) {
    return id
  }

  const cacheKey = `${branch}:${id}`

  // Check cache first
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey)
  }

  try {
    // Fetch from API (single ID)
    const apiClient = createApiClient()
    const result = await apiClient.content.resolveReferences(
      { branch },
      { ids: [id] }
    )

    if (result.ok && result.data && result.data.resolved[id]) {
      // Cache and return resolved object
      const resolved = result.data.resolved[id]
      cache.set(cacheKey, resolved)
      return resolved
    }

    // Resolution failed - return original ID string
    return id
  } catch (error) {
    console.error(`Failed to resolve reference ID ${id}:`, error)
    // Return original ID on error
    return id
  }
}
