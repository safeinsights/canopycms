/**
 * Reference fields in AI content: resolving them, hiding targets the export leaves out, and the
 * title and URL a resolved one renders with.
 *
 * A reference renders as a link to its target, never as the target's content, so a shared block
 * referenced by forty pages appears once in the export rather than forty times.
 */

import path from 'node:path'

import type { ContentStore } from '../content-store'
import { getDefaultEntryType } from '../content-store'
import { extractEntryTypeFromFilename, type ContentIdIndex } from '../content-id-index'
import type { EntryTypeConfig, FieldConfig, FlatSchemaItem, ReferenceFieldConfig } from '../config'
import { RESTRICTED_REFERENCE_MARKER } from '../entry-schema'
import type { EntryLinkUrlResolver } from '../entry-link-resolver'
import { flattenGroupFields } from '../utils/flatten-group-fields'
import { resolveEntryTitle } from '../utils/title-field'
import { traverseFields } from '../validation/field-traversal'
import type { ReferenceRendering } from './json-to-markdown'
import type { AIEntry, AIReferenceValue, AIUnavailableReference } from './types'

export type ReferenceTargetResolver = (id: string) => Promise<AIReferenceValue>

/**
 * Resolve reference ids to their targets, reading each target once.
 *
 * Create one per `generateAIContent` call and never keep it: the route handler is long-lived in
 * prod, and a memo held across calls would serve a target as it was when first read.
 * `resolveReferenceTarget` embeds no body, which keeps the target's content out of the export.
 */
export function createReferenceTargetResolver(store: ContentStore): ReferenceTargetResolver {
  const reads = new Map<string, Promise<Record<string, unknown> | null>>()
  return async (id) => {
    let read = reads.get(id)
    if (!read) {
      read = store.resolveReferenceTarget(id)
      reads.set(id, read)
    }
    const target = await read
    if (target === null) return { id, unavailable: true, reason: 'missing' }
    // Each occurrence gets its own copy, since masking and adopter transforms may mutate it.
    return structuredClone(target) as AIReferenceValue
  }
}

/** Each reference field's holding record, at every depth: objects, object lists, blocks, groups. */
function referenceSlots(
  fields: readonly FieldConfig[],
  data: Record<string, unknown>,
): Array<{ record: Record<string, unknown>; field: ReferenceFieldConfig }> {
  return traverseFields<{ record: Record<string, unknown>; field: ReferenceFieldConfig }>(
    fields,
    data,
    () => [],
    '',
    ({ fields: containerFields, data: record }) =>
      flattenGroupFields(containerFields)
        .filter((field): field is ReferenceFieldConfig => field.type === 'reference')
        .map((field) => ({ record, field })),
  )
}

/**
 * A copy of `data` with every reference id replaced by its target, or by an
 * {@link AIUnavailableReference} when the id names no entry, so the id survives into the output.
 * A `list: true` field resolves each string element; any other shape is left as stored.
 */
export async function resolveReferenceFields(
  data: Record<string, unknown>,
  fields: readonly FieldConfig[],
  resolveTarget: ReferenceTargetResolver,
): Promise<Record<string, unknown>> {
  const resolved = structuredClone(data)
  await Promise.all(
    referenceSlots(fields, resolved).map(async ({ record, field }) => {
      const value = record[field.name]
      if (typeof value === 'string' && value) {
        record[field.name] = await resolveTarget(value)
      } else if (field.list && Array.isArray(value)) {
        record[field.name] = await Promise.all(
          value.map((id) => (typeof id === 'string' && id ? resolveTarget(id) : id)),
        )
      }
    }),
  )
  return resolved
}

function isShownTarget(value: unknown): value is Record<string, unknown> & { id: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).id === 'string' &&
    (value as Record<string, unknown>)[RESTRICTED_REFERENCE_MARKER] !== true
  )
}

/**
 * Replace, in place, every resolved target that is not itself in this export with an
 * {@link AIUnavailableReference}, so no title, URL or field of an excluded entry reaches the
 * output. Runs before entry transforms and rendering, which therefore never see such a target.
 * Returns whether it replaced anything.
 */
export function maskUnexportedTargets(
  entry: AIEntry,
  exported: { has(id: string): boolean },
): boolean {
  let masked = false
  const mask = (value: unknown): unknown => {
    if (!isShownTarget(value) || exported.has(value.id)) return value
    masked = true
    return { id: value.id, unavailable: true, reason: 'excluded' } satisfies AIUnavailableReference
  }
  for (const { record, field } of referenceSlots(entry.fields, entry.data)) {
    const value = record[field.name]
    if (value === undefined) continue
    record[field.name] = Array.isArray(value) ? value.map(mask) : mask(value)
  }
  return masked
}

/**
 * Title and URLs for a resolved target. The title is `resolveEntryTitle` against the target's own
 * entry type, the chain the entries API labels an entry with. The page URL follows the rule body
 * `entry:` links use, so both kinds of link in one document agree. The markdown copy is the file
 * this export wrote for the target (`files`: content id to output path), under `mountPath`.
 */
export function createReferenceRendering(
  idIndex: ContentIdIndex,
  flatSchema: readonly FlatSchemaItem[],
  entryLinkUrl: EntryLinkUrlResolver | undefined,
  markdownCopies: { mountPath: string; files: ReadonlyMap<string, string> },
): ReferenceRendering {
  const mount = `/${markdownCopies.mountPath.replace(/^\/+|\/+$/g, '')}`.replace(/^\/$/, '')
  const entryTypeOf = (id: unknown): { schema?: readonly FieldConfig[]; label?: string } => {
    const location = typeof id === 'string' ? idIndex.findById(id) : null
    if (!location?.collection) return {}
    const item = flatSchema.find((candidate) => candidate.logicalPath === location.collection)
    if (!item) return {}
    if (item.type === 'entry-type') return { schema: item.schema, label: item.label }
    if (item.type !== 'collection') return {}
    const typeName = extractEntryTypeFromFilename(path.basename(location.relativePath))
    const entries = item.entries as readonly EntryTypeConfig[] | undefined
    const entryType =
      entries?.find((candidate) => candidate.name === typeName) ?? getDefaultEntryType(entries)
    return { schema: entryType?.schema, label: entryType?.label }
  }

  return {
    title: (target) => {
      const { schema, label } = entryTypeOf(target.id)
      return resolveEntryTitle(target, {
        schema,
        entryTypeLabel: label,
        slug: typeof target.slug === 'string' ? target.slug : undefined,
      })
    },
    url: (target) => {
      const { id, slug, collection, urlPath } = target
      if (
        entryLinkUrl &&
        typeof id === 'string' &&
        typeof slug === 'string' &&
        typeof collection === 'string'
      ) {
        return entryLinkUrl({ collection, slug, id })
      }
      return typeof urlPath === 'string' && urlPath ? urlPath : undefined
    },
    markdownUrl: (target) => {
      const file = typeof target.id === 'string' ? markdownCopies.files.get(target.id) : undefined
      return file ? `${mount}/${file}` : undefined
    },
  }
}
