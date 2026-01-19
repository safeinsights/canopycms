/**
 * Configuration validation utilities.
 */

import { CanopyConfigSchema } from './schemas/config'
import { normalizePathValue, normalizeSchemaPathsRoot } from './flatten'
import type { CanopyConfig } from './types'

/**
 * Recursively check that all select fields have options defined.
 * Throws an error if a select field is missing options.
 */
export const ensureSelectFieldsHaveOptions = (config: unknown): void => {
  const checkFields = (fields: unknown[] | undefined) => {
    if (!Array.isArray(fields)) return
    for (const field of fields) {
      const f = field as Record<string, unknown>
      if (f?.type === 'select' && (!Array.isArray(f.options) || f.options.length === 0)) {
        const fieldName = (f?.name as string) ?? 'unknown'
        throw new Error(`Select field "${fieldName}" requires options`)
      }
      if (f?.type === 'object') {
        checkFields(f.fields as unknown[])
      }
      if (f?.type === 'block' && Array.isArray(f.templates)) {
        for (const template of f.templates as Array<{ fields?: unknown[] }>) {
          checkFields(template.fields)
        }
      }
    }
  }

  const walkSchema = (root: Record<string, unknown> | undefined) => {
    if (!root) return
    // Check entries fields (now an array of entry types)
    if (Array.isArray(root.entries)) {
      for (const entryType of root.entries as Array<{ fields?: unknown[] }>) {
        checkFields(entryType?.fields)
      }
    }
    // Recursively check nested collections
    if (Array.isArray(root.collections)) {
      for (const collection of root.collections as Array<Record<string, unknown>>) {
        walkSchema(collection)
      }
    }
  }

  walkSchema((config as Record<string, unknown>)?.schema as Record<string, unknown>)
}

/**
 * Validate and normalize a CanopyConfig object.
 * Performs Zod validation, checks select field options, and normalizes paths.
 *
 * @param config - Raw configuration input
 * @returns Validated and normalized CanopyConfig
 * @throws Error if validation fails
 */
export const validateCanopyConfig = (config: unknown): CanopyConfig => {
  ensureSelectFieldsHaveOptions(config)
  const parsed = CanopyConfigSchema.parse(config)
  const normalized = {
    ...parsed,
    contentRoot: normalizePathValue(parsed.contentRoot ?? 'content'),
    schema: parsed.schema ? normalizeSchemaPathsRoot(parsed.schema) : undefined,
  }

  return normalized as CanopyConfig
}
