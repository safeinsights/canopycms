/**
 * Field-shape validation utilities for entry schemas.
 *
 * These helpers validate individual `EntrySchema` field arrays — they're invoked
 * from `createEntrySchemaRegistry` so the canonical schema-authoring path runs
 * the same checks. Exported so the test suite can exercise them directly.
 */

import { CanopyConfigSchema } from './schemas/config'
import { normalizePathValue } from './flatten'
import type { CanopyConfig } from './types'

/**
 * Recursively check that all select fields have options defined.
 * Throws an error if a select field is missing options.
 */
export const ensureSelectFieldsHaveOptions = (fields: unknown): void => {
  if (!Array.isArray(fields)) return
  for (const field of fields) {
    const f = field as Record<string, unknown>
    if (f?.type === 'select' && (!Array.isArray(f.options) || f.options.length === 0)) {
      const fieldName = (f?.name as string) ?? 'unknown'
      throw new Error(`Select field "${fieldName}" requires options`)
    }
    if (f?.type === 'group') {
      ensureSelectFieldsHaveOptions(f.fields)
    }
    if (f?.type === 'object') {
      ensureSelectFieldsHaveOptions(f.fields)
    }
    if (f?.type === 'block' && Array.isArray(f.templates)) {
      for (const template of f.templates as Array<{ fields?: unknown }>) {
        ensureSelectFieldsHaveOptions(template.fields)
      }
    }
  }
}

/**
 * Recursively check that all reference fields have at least one of `collections` or `entryTypes`.
 * Throws an error if a reference field has neither.
 */
export const ensureReferenceFieldsHaveScope = (fields: unknown): void => {
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
      ensureReferenceFieldsHaveScope(f.fields)
    }
    if (f?.type === 'object') {
      ensureReferenceFieldsHaveScope(f.fields)
    }
    if (f?.type === 'block' && Array.isArray(f.templates)) {
      for (const template of f.templates as Array<{ fields?: unknown }>) {
        ensureReferenceFieldsHaveScope(template.fields)
      }
    }
  }
}

/**
 * Validate that inline groups don't cause field name collisions within the same scope.
 * Because inline groups flatten their children into the parent scope, a field name used
 * in a group that also appears as a sibling field (or in another group) will silently
 * overwrite data on read/write.
 *
 * Pass a label (typically the entry-type name from the registry) for clearer error messages.
 */
export const ensureNoFlattenedFieldNameCollisions = (
  fields: unknown,
  scopeLabel = 'entry schema',
): void => {
  // Collect all effective field names at a scope level (groups are transparent)
  const collectNamesAtScope = (scopeFields: unknown[]): string[] => {
    const names: string[] = []
    for (const field of scopeFields) {
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
  const collectComplexFields = (scopeFields: unknown[]): Array<Record<string, unknown>> => {
    const result: Array<Record<string, unknown>> = []
    for (const field of scopeFields) {
      const f = field as Record<string, unknown>
      if (f?.type === 'group') {
        result.push(...collectComplexFields((f.fields as unknown[]) ?? []))
      } else if (f?.type === 'object' || f?.type === 'block') {
        result.push(f)
      }
    }
    return result
  }

  const checkScope = (scopeFields: unknown[] | undefined, label: string): void => {
    if (!Array.isArray(scopeFields)) return

    // Check for collisions at this scope (groups flattened in)
    const names = collectNamesAtScope(scopeFields)
    const seen = new Set<string>()
    for (const name of names) {
      if (seen.has(name)) {
        throw new Error(
          `Field name collision in ${label}: field "${name}" appears more than once. ` +
            `Note: inline groups flatten their fields into the parent scope.`,
        )
      }
      seen.add(name)
    }

    // Recurse into nested scopes (object fields and block templates have their own scope)
    for (const f of collectComplexFields(scopeFields)) {
      if (f.type === 'object') {
        checkScope(f.fields as unknown[], `${label} > object "${f.name}"`)
      } else if (f.type === 'block' && Array.isArray(f.templates)) {
        for (const template of f.templates as Array<{ name?: unknown; fields?: unknown[] }>) {
          checkScope(template.fields, `${label} > block "${f.name}" template "${template.name}"`)
        }
      }
    }
  }

  if (!Array.isArray(fields)) return
  checkScope(fields, scopeLabel)
}

/**
 * Validate that inline groups (type: 'group') only appear at the top level of entry
 * schemas, not inside object or block fields. Groups inside complex fields would produce
 * correct TypeScript types but broken editor rendering.
 */
export const ensureNoGroupsInsideComplexFields = (fields: unknown): void => {
  const checkFields = (scopeFields: unknown[] | undefined, parentType?: string): void => {
    if (!Array.isArray(scopeFields)) return
    for (const field of scopeFields) {
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

  checkFields(Array.isArray(fields) ? fields : undefined)
}

/**
 * Validate and normalize a CanopyConfig object.
 * Performs Zod validation and normalizes paths. Field-shape validation for
 * entry schemas runs at `createEntrySchemaRegistry` time.
 *
 * @param config - Raw configuration input
 * @returns Validated and normalized CanopyConfig
 * @throws Error if validation fails
 */
export const validateCanopyConfig = (config: unknown): CanopyConfig => {
  const parsed = CanopyConfigSchema.parse(config)
  const normalized = {
    ...parsed,
    contentRoot: normalizePathValue(parsed.contentRoot ?? 'content'),
  }

  return normalized as CanopyConfig
}
