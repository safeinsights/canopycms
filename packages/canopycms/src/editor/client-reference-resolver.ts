import type { EntrySchema, FieldConfig, ReferenceFieldConfig } from '../config'
import type { FormValue } from './FormRenderer'
import { createApiClient } from '../api/client'
import type { ApiClient } from './context'
import { flattenGroupFields } from '../utils/flatten-group-fields'

/**
 * Client-side utility for incrementally resolving reference fields in form data.
 * Used by FormRenderer to transform draft data before sending to preview.
 *
 * This module is a plain function file, not a hook/component -- it's invoked from inside a
 * `setTimeout` callback in `useReferenceResolution`'s effect, well after that render has
 * finished, where calling a React hook would violate the rules of hooks. So the API client
 * can't be sourced here via `useApiClient()`/`useOptionalApiClient()` directly; instead every
 * entry point takes an optional `apiClient`, which the caller (a hook, which CAN call
 * `useOptionalApiClient()` during render) resolves and passes down. Falls back to a
 * default-configured `createApiClient()` when no client is supplied.
 */

/**
 * Only returns top-level field configs for fields that changed.
 */
export function findChangedFields(
  prevValue: FormValue,
  currentValue: FormValue,
  schema: EntrySchema,
): FieldConfig[] {
  const changed: FieldConfig[] = []

  for (const field of flattenGroupFields(schema)) {
    const prevFieldValue = prevValue[field.name]
    const currentFieldValue = currentValue[field.name]

    if (JSON.stringify(prevFieldValue) !== JSON.stringify(currentFieldValue)) {
      changed.push(field)
    }
  }

  return changed
}

/**
 * Uses cache to avoid duplicate API calls.
 */
export async function resolveChangedReferences(
  prevValue: FormValue,
  currentValue: FormValue,
  schema: EntrySchema,
  branch: string,
  cache: Map<string, unknown>,
  apiClient?: ApiClient,
): Promise<Partial<FormValue>> {
  const changedFields = findChangedFields(prevValue, currentValue, schema)
  const updates: Partial<FormValue> = {}

  for (const field of changedFields) {
    if (field.type === 'reference') {
      const refField = field as ReferenceFieldConfig
      const fieldValue = currentValue[field.name]

      if (refField.list && Array.isArray(fieldValue)) {
        const resolved = await Promise.all(
          fieldValue.map((id) => resolveReferenceId(id, branch, cache, apiClient)),
        )
        updates[field.name] = resolved
      } else if (fieldValue) {
        const resolved = await resolveReferenceId(fieldValue, branch, cache, apiClient)
        updates[field.name] = resolved
      }
    }
  }

  return updates
}

async function resolveReferenceId(
  id: unknown,
  branch: string,
  cache: Map<string, unknown>,
  apiClient?: ApiClient,
): Promise<unknown> {
  if (typeof id !== 'string') {
    return id
  }

  // Check if already resolved (has __typename or other object properties)
  if (typeof id === 'object' && id !== null) {
    return id
  }

  const cacheKey = `${branch}:${id}`

  if (cache.has(cacheKey)) {
    return cache.get(cacheKey)
  }

  try {
    // Fetch from API (single ID) -- use the caller-supplied (context-sourced) client when
    // available, so requests carry the deployment's configured basePath; fall back to a
    // default-configured client for direct callers that don't have one to hand.
    const client = apiClient ?? createApiClient()
    const result = await client.content.resolveReferences({ branch }, { ids: [id] })

    if (result.ok && result.data && result.data.resolved[id]) {
      const resolved = result.data.resolved[id]
      cache.set(cacheKey, resolved)
      return resolved
    }

    return id
  } catch (error) {
    console.error(`Failed to resolve reference ID ${id}:`, error)
    return id
  }
}
