/**
 * Shared field traversal utility for schema-aware data traversal.
 *
 * This module provides a generic way to traverse nested data structures
 * according to a schema, handling objects, blocks, and arrays with their
 * own schemas.
 */

import type {
  FieldConfig,
  ObjectFieldConfig,
  BlockFieldConfig,
  InlineGroupFieldConfig,
} from '../config'

/**
 * Context provided to the visitor function for each field.
 */
export interface TraversalContext {
  /** The field configuration from the schema */
  field: FieldConfig
  /** The value at this field in the data */
  value: unknown
  /** The dot-notation path to this field (e.g., "author.name" or "blocks[0].title") */
  path: string
}

/**
 * Visitor function that receives each field and can return results.
 * Return an empty array to skip this field, or return items to collect.
 */
export type FieldVisitor<T> = (context: TraversalContext) => T[]

/**
 * Context for a CONTAINER — one data record together with the field list that governs it.
 *
 * The field visitor is driven by the schema, so it can only ever see keys the schema already
 * knows about. A container visitor sees the record itself, which is what a check on the data's
 * OWN keys needs (`findUnknownKeys` in entry-validator.ts).
 */
interface ContainerContext {
  /** The schema fields governing this record. Inline groups are NOT flattened. */
  fields: readonly FieldConfig[]
  /** The data record those fields govern. */
  data: Record<string, unknown>
  /** Path to the record itself ('' at the top level, e.g. `blocks[0]` inside a block). */
  path: string
}

/**
 * Visitor called once per container, before its fields are walked.
 * Return an empty array to collect nothing.
 */
export type ContainerVisitor<T> = (context: ContainerContext) => T[]

/**
 * A block item resolved to its template fields and the data record that
 * holds the nested field values.
 */
export interface ResolvedBlockItem {
  /** The template's field schema */
  fields: FieldConfig[]
  /** The record containing the block's nested field values */
  data: Record<string, unknown>
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Resolve a block item to its template fields and nested data record.
 *
 * Real block data — as produced by the editor (BlockField.tsx) and persisted
 * by ContentStore — has the shape `{ template: string, value: {...} }`:
 * the template name lives on `template` and the nested field values live
 * under `value`. A `_type` discriminator with inline field values is also
 * accepted defensively (mirroring ai/json-to-markdown.ts).
 *
 * Returns undefined when the item has no resolvable template.
 */
export function resolveBlockItem(
  blockField: BlockFieldConfig,
  item: Record<string, unknown>,
): ResolvedBlockItem | undefined {
  const templateName =
    typeof item.template === 'string'
      ? item.template
      : typeof item._type === 'string'
        ? item._type
        : undefined
  if (!templateName) return undefined

  // Block fields use 'templates' property
  const template = blockField.templates?.find((t) => t.name === templateName)
  if (!template?.fields) return undefined

  // Nested field values live under `value` in the canonical shape; fall back
  // to the item itself for the inline `_type` shape.
  const data = isPlainRecord(item.value) ? item.value : item

  return { fields: template.fields, data }
}

/**
 * Recursively traverse fields in data according to schema.
 *
 * @param fields - The schema fields to traverse
 * @param data - The data object to traverse
 * @param visitor - Function called for each field, returns items to collect
 * @param pathPrefix - Current path prefix for nested fields
 * @param onContainer - Optional, called once per container (this record plus the fields
 *   governing it) before its fields are walked: the top level, each object value, each
 *   object-list item, and each block item's resolved data.
 * @returns Array of all items returned by the visitors
 */
export function traverseFields<T>(
  fields: readonly FieldConfig[],
  data: Record<string, unknown>,
  visitor: FieldVisitor<T>,
  pathPrefix = '',
  onContainer?: ContainerVisitor<T>,
): T[] {
  return walkFields(fields, data, visitor, pathPrefix, onContainer, true)
}

/**
 * The traversal itself. `fireContainer` is what keeps an inline group from being mistaken for a
 * container: a group re-enters the walk with the SAME data record, so firing the hook there would
 * report the record twice AND hand the visitor only the group's own field list — under which
 * every sibling of the group reads as an unknown key. The hook still propagates INTO the group,
 * so a nested object or block below it is reported normally.
 */
function walkFields<T>(
  fields: readonly FieldConfig[],
  data: Record<string, unknown>,
  visitor: FieldVisitor<T>,
  pathPrefix: string,
  onContainer: ContainerVisitor<T> | undefined,
  fireContainer: boolean,
): T[] {
  const results: T[] = []

  if (onContainer && fireContainer) {
    results.push(...onContainer({ fields, data, path: pathPrefix }))
  }

  for (const field of fields) {
    const fieldPath = pathPrefix ? `${pathPrefix}.${field.name}` : field.name
    const value = data[field.name]

    // Inline groups are transparent to the data — their children live at the parent
    // data level, not under field.name, so skip the null/undefined guard for them.
    if (field.type === 'group') {
      results.push(
        ...walkFields(
          (field as InlineGroupFieldConfig).fields,
          data,
          visitor,
          pathPrefix,
          onContainer,
          false,
        ),
      )
      continue
    }

    if (value === undefined || value === null) continue

    results.push(...visitor({ field, value, path: fieldPath }))

    if (field.type === 'object') {
      const objectField = field as ObjectFieldConfig
      if (objectField.fields) {
        if (Array.isArray(value)) {
          // list: true — value is an array of objects
          value.forEach((item, index) => {
            if (typeof item === 'object' && item !== null) {
              results.push(
                ...walkFields(
                  objectField.fields!,
                  item as Record<string, unknown>,
                  visitor,
                  `${fieldPath}[${index}]`,
                  onContainer,
                  true,
                ),
              )
            }
          })
        } else if (typeof value === 'object' && value !== null) {
          results.push(
            ...walkFields(
              objectField.fields,
              value as Record<string, unknown>,
              visitor,
              fieldPath,
              onContainer,
              true,
            ),
          )
        }
      }
    } else if (field.type === 'block') {
      const blockField = field as BlockFieldConfig
      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          if (typeof item === 'object' && item !== null) {
            const resolved = resolveBlockItem(blockField, item as Record<string, unknown>)
            if (resolved) {
              results.push(
                ...walkFields(
                  resolved.fields,
                  resolved.data,
                  visitor,
                  `${fieldPath}[${index}]`,
                  onContainer,
                  true,
                ),
              )
            }
          }
        })
      }
    }
  }

  return results
}

export function findFieldsByType(
  fields: readonly FieldConfig[],
  data: Record<string, unknown>,
  fieldType: string,
): TraversalContext[] {
  return traverseFields(fields, data, (ctx) => {
    if (ctx.field.type === fieldType) {
      return [ctx]
    }
    return []
  })
}
