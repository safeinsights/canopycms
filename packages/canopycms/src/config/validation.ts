/**
 * Field-shape validation utilities for entry schemas.
 *
 * These helpers validate individual `EntrySchema` field arrays — they're invoked
 * from `createEntrySchemaRegistry` so the canonical schema-authoring path runs
 * the same checks. Exported so the test suite can exercise them directly.
 */

import { CanopyConfigSchema } from './schemas/config'
import { normalizePathValue } from './flatten'
// Leaf module, NOT the `operating-mode` barrel: the barrel re-exports the
// client-unsafe strategy (node:fs/node:path) and this file is reachable from
// `canopycms/client` (the generated editor page imports the adopter's config).
import { resolveOperatingMode } from '../operating-mode/mode-env'
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
  forEachReferenceField(fields, (f) => {
    const hasCollections = Array.isArray(f.collections) && f.collections.length > 0
    const hasEntryTypes = Array.isArray(f.entryTypes) && f.entryTypes.length > 0
    if (!hasCollections && !hasEntryTypes) {
      const fieldName = (f?.name as string) ?? 'unknown'
      throw new Error(
        `Reference field "${fieldName}" requires at least one of "collections" or "entryTypes"`,
      )
    }
  })
}

/**
 * Walk a schema's fields and invoke `visit` for every reference field, descending
 * into `group`/`object` fields and into each `block` template's fields.
 *
 * Schema-only by design: unlike validation/field-traversal.ts's `findFieldsByType`,
 * which walks a schema alongside a concrete entry's data, this needs no data and so
 * can run at config-validation and schema-load time, before any entry exists.
 */
export const forEachReferenceField = (
  fields: unknown,
  visit: (field: Record<string, unknown>) => void,
): void => {
  if (!Array.isArray(fields)) return
  for (const field of fields) {
    const f = field as Record<string, unknown>
    if (f?.type === 'reference') {
      visit(f)
    }
    if (f?.type === 'group' || f?.type === 'object') {
      forEachReferenceField(f.fields, visit)
    }
    if (f?.type === 'block' && Array.isArray(f.templates)) {
      for (const template of f.templates as Array<{ fields?: unknown }>) {
        forEachReferenceField(template.fields, visit)
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

  checkScope(Array.isArray(fields) ? fields : undefined, scopeLabel)
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
 * `mode` is resolved through `resolveOperatingMode` here rather than taken
 * verbatim from the parsed config: one `canopycms.config.ts` is shared by
 * local dev, the image build and the deployment, so the deployed value has to
 * come from the environment. This is the single point every documented
 * config-authoring path (`defineCanopyConfig`, `composeCanopyConfig`) funnels
 * through, so the override cannot be bypassed by picking a different helper.
 * The Zod schema still REQUIRES `mode` — the override replaces a declared
 * value, it never supplies a missing one (SEC-C1).
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
    mode: resolveOperatingMode(parsed.mode),
  }

  return normalized as CanopyConfig
}
