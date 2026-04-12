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
      if (f?.type === 'group') {
        checkFields(f.fields as unknown[])
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
      for (const entryType of root.entries as Array<{ schema?: unknown[] }>) {
        checkFields(entryType?.schema)
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
 * Recursively check that all reference fields have at least one of `collections` or `entryTypes`.
 * Throws an error if a reference field has neither.
 */
export const ensureReferenceFieldsHaveScope = (config: unknown): void => {
  const checkFields = (fields: unknown[] | undefined) => {
    if (!Array.isArray(fields)) return
    for (const field of fields) {
      const f = field as Record<string, unknown>
      if (f?.type === 'reference') {
        const hasCollections = Array.isArray(f.collections) && f.collections.length > 0
        const hasEntryTypes = Array.isArray(f.entryTypes) && f.entryTypes.length > 0
        if (!hasCollections && !hasEntryTypes) {
          const fieldName = (f?.name as string) ?? 'unknown'
          throw new Error(
            `Reference field "${fieldName}" requires at least one of "collections" or "entryTypes"`,
          )
        }
      }
      if (f?.type === 'group') {
        checkFields(f.fields as unknown[])
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
    if (Array.isArray(root.entries)) {
      for (const entryType of root.entries as Array<{ schema?: unknown[] }>) {
        checkFields(entryType?.schema)
      }
    }
    if (Array.isArray(root.collections)) {
      for (const collection of root.collections as Array<Record<string, unknown>>) {
        walkSchema(collection)
      }
    }
  }

  walkSchema((config as Record<string, unknown>)?.schema as Record<string, unknown>)
}

/**
 * Validate that inline groups don't cause field name collisions within the same scope.
 * Because inline groups flatten their children into the parent scope, a field name used
 * in a group that also appears as a sibling field (or in another group) will silently
 * overwrite data on read/write.
 */
export const ensureNoFlattenedFieldNameCollisions = (config: unknown): void => {
  // Collect all effective field names at a scope level (groups are transparent)
  const collectNamesAtScope = (fields: unknown[]): string[] => {
    const names: string[] = []
    for (const field of fields) {
      const f = field as Record<string, unknown>
      if (f?.type === 'group') {
        names.push(...collectNamesAtScope((f.fields as unknown[]) ?? []))
      } else if (typeof f?.name === 'string') {
        names.push(f.name)
      }
    }
    return names
  }

  // Collect all object/block fields at a scope level (including those inside groups)
  const collectComplexFields = (fields: unknown[]): Array<Record<string, unknown>> => {
    const result: Array<Record<string, unknown>> = []
    for (const field of fields) {
      const f = field as Record<string, unknown>
      if (f?.type === 'group') {
        result.push(...collectComplexFields((f.fields as unknown[]) ?? []))
      } else if (f?.type === 'object' || f?.type === 'block') {
        result.push(f)
      }
    }
    return result
  }

  const checkScope = (fields: unknown[] | undefined, scopeLabel: string): void => {
    if (!Array.isArray(fields)) return

    // Check for collisions at this scope (groups flattened in)
    const names = collectNamesAtScope(fields)
    const seen = new Set<string>()
    for (const name of names) {
      if (seen.has(name)) {
        throw new Error(
          `Field name collision in ${scopeLabel}: field "${name}" appears more than once. ` +
            `Note: inline groups flatten their fields into the parent scope.`,
        )
      }
      seen.add(name)
    }

    // Recurse into nested scopes (object fields and block templates have their own scope)
    for (const f of collectComplexFields(fields)) {
      if (f.type === 'object') {
        checkScope(f.fields as unknown[], `${scopeLabel} > object "${f.name}"`)
      } else if (f.type === 'block' && Array.isArray(f.templates)) {
        for (const template of f.templates as Array<{ name?: unknown; fields?: unknown[] }>) {
          checkScope(
            template.fields,
            `${scopeLabel} > block "${f.name}" template "${template.name}"`,
          )
        }
      }
    }
  }

  const walkSchema = (root: Record<string, unknown> | undefined): void => {
    if (!root) return
    if (Array.isArray(root.entries)) {
      for (const entryType of root.entries as Array<{ name?: unknown; schema?: unknown[] }>) {
        checkScope(entryType?.schema, `entry type "${entryType.name}"`)
      }
    }
    if (Array.isArray(root.collections)) {
      for (const collection of root.collections as Array<Record<string, unknown>>) {
        walkSchema(collection)
      }
    }
  }

  walkSchema((config as Record<string, unknown>)?.schema as Record<string, unknown>)
}

/**
 * Validate that inline groups (type: 'group') only appear at the top level of entry
 * schemas, not inside object or block fields. Groups inside complex fields would produce
 * correct TypeScript types but broken editor rendering.
 */
export const ensureNoGroupsInsideComplexFields = (config: unknown): void => {
  const checkFields = (fields: unknown[] | undefined, parentType?: string): void => {
    if (!Array.isArray(fields)) return
    for (const field of fields) {
      const f = field as Record<string, unknown>
      if (f?.type === 'group') {
        if (parentType) {
          const groupName = (f?.name as string) ?? 'unnamed'
          throw new Error(
            `Inline group "${groupName}" cannot be nested inside a ${parentType} field. ` +
              `Use defineInlineFieldGroup() only at the top level of an entry schema or inside another group.`,
          )
        }
        // Top-level group — recurse to check its own children
        checkFields(f.fields as unknown[], undefined)
      }
      if (f?.type === 'object') {
        checkFields(f.fields as unknown[], 'object')
      }
      if (f?.type === 'block' && Array.isArray(f.templates)) {
        for (const template of f.templates as Array<{ fields?: unknown[] }>) {
          checkFields(template.fields, 'block')
        }
      }
    }
  }

  const walkSchema = (root: Record<string, unknown> | undefined): void => {
    if (!root) return
    if (Array.isArray(root.entries)) {
      for (const entryType of root.entries as Array<{ schema?: unknown[] }>) {
        checkFields(entryType?.schema)
      }
    }
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
  ensureReferenceFieldsHaveScope(config)
  ensureNoGroupsInsideComplexFields(config)
  ensureNoFlattenedFieldNameCollisions(config)
  const parsed = CanopyConfigSchema.parse(config)
  const normalized = {
    ...parsed,
    contentRoot: normalizePathValue(parsed.contentRoot ?? 'content'),
    schema: parsed.schema ? normalizeSchemaPathsRoot(parsed.schema) : undefined,
  }

  return normalized as CanopyConfig
}
