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
import { extractEntryLinkIds, type EntryLinkUrlResolver } from '../entry-link-resolver'
import { getErrorMessage } from '../utils/error'
import { flattenGroupFields } from '../utils/flatten-group-fields'
import { resolveEntryTitle } from '../utils/title-field'
import { traverseFields } from '../validation/field-traversal'
import type { ReferenceRendering } from './json-to-markdown'
import type {
  AIEntry,
  AIExcludedReference,
  AIReferenceLinkFn,
  AIResolvedReference,
  AIReferenceValue,
} from './types'

export type ReferenceTargetResolver = (id: string) => Promise<AIReferenceValue>

/**
 * Resolve reference ids to their targets, reading each target once.
 *
 * Create one per `generateAIContent` call and never keep it: the route handler is long-lived in
 * prod, and a memo held across calls would serve a target as it was when first read.
 * `resolveReferenceTarget` embeds no body, which keeps the target's content out of the export,
 * and resolves an id naming no readable entry to a `MissingReference`, which keeps the id.
 */
export function createReferenceTargetResolver(store: ContentStore): ReferenceTargetResolver {
  const reads = new Map<string, Promise<Record<string, unknown>>>()
  return async (id) => {
    let read = reads.get(id)
    if (!read) {
      read = store.resolveReferenceTarget(id)
      reads.set(id, read)
    }
    // Each occurrence gets its own copy, since masking and adopter transforms may mutate it.
    return structuredClone(await read) as AIReferenceValue
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
 * A copy of `data` with every reference id replaced by its target, or by a `MissingReference`
 * when the id names no readable entry, so the id survives into the output.
 * A `list: true` field resolves each non-empty string element; any other value, including the
 * `''` of a cleared reference, is left as stored.
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
 * {@link AIExcludedReference}, so no title, URL or field of an excluded entry reaches the
 * output. Runs before each round of entry transforms and rendering, so their final output never
 * carries such a target. Returns whether it replaced anything.
 */
export function maskUnexportedTargets(
  entry: AIEntry,
  exported: { has(id: string): boolean },
): boolean {
  let masked = false
  const mask = (value: unknown): unknown => {
    if (!isShownTarget(value) || exported.has(value.id)) return value
    masked = true
    return { id: value.id, unavailable: true, reason: 'excluded' } satisfies AIExcludedReference
  }
  for (const { record, field } of referenceSlots(entry.fields, entry.data)) {
    const value = record[field.name]
    if (value === undefined) continue
    record[field.name] = Array.isArray(value) ? value.map(mask) : mask(value)
  }
  return masked
}

/**
 * The page URL a resolved target links by default: `entryLinkUrl`'s, else its `urlPath`, the rule
 * body `entry:` links use.
 */
function defaultPageUrl(
  target: Record<string, unknown>,
  entryLinkUrl: EntryLinkUrlResolver | undefined,
): string | undefined {
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
}

/** A target's page link as `referenceLink` decided it: a URL, `false` for none, or the default. */
export type ReferenceLinkLookup = (id: string) => string | false | undefined

/**
 * Ask `referenceLink` once for each exported target the export's entries reference or link from
 * their bodies, in entry order, and return the answers. Run it once the exclusions have settled
 * the export set, so the callback never sees an excluded or missing target; one whose own render
 * fails later is masked like any other, and its answer goes unused. A body reaches the callback from
 * `bodyOf` and nowhere else, which keeps it out of the output. A throw or a return other than a
 * non-empty string, `false` or `undefined` is logged and becomes `false`, so a broken callback
 * withholds a link rather than advertising a page the site may not have.
 */
export async function decideReferenceLinks(
  referenceLink: AIReferenceLinkFn,
  entries: ReadonlyArray<{ entry: AIEntry; body?: string }>,
  exported: { has(id: string): boolean },
  resolveTarget: ReferenceTargetResolver,
  bodyOf: (id: string) => string | undefined,
  entryLinkUrl: EntryLinkUrlResolver | undefined,
): Promise<ReferenceLinkLookup> {
  const ids = new Set<string>()
  for (const { entry, body } of entries) {
    for (const { record, field } of referenceSlots(entry.fields, entry.data)) {
      const value = record[field.name]
      for (const target of Array.isArray(value) ? value : [value]) {
        if (isShownTarget(target) && exported.has(target.id)) ids.add(target.id)
      }
    }
    for (const { id } of body ? extractEntryLinkIds(body) : []) {
      if (exported.has(id)) ids.add(id)
    }
  }

  const decisions = new Map<string, string | false | undefined>()
  for (const id of ids) {
    const target = await resolveTarget(id)
    if (!isShownTarget(target)) continue
    let decision: unknown
    try {
      decision = await referenceLink(target as AIResolvedReference, {
        body: bodyOf(id),
        defaultUrl: defaultPageUrl(target, entryLinkUrl),
      })
    } catch (err) {
      console.warn(`AI content: referenceLink threw for entry ${id}:`, getErrorMessage(err))
      decision = false
    }
    if (typeof decision === 'string' && decision.trim()) {
      decisions.set(id, decision.trim())
    } else if (decision === false || decision === undefined) {
      decisions.set(id, decision)
    } else {
      console.warn(
        `AI content: referenceLink returned ${typeof decision === 'string' ? 'an empty string' : typeof decision} for entry ${id}; expected a URL, false or undefined`,
      )
      decisions.set(id, false)
    }
  }
  return (id) => decisions.get(id)
}

/**
 * Title and URLs for a resolved target. The title is `resolveEntryTitle` against the target's own
 * entry type, the chain the entries API labels an entry with. The page URL is `linkFor`'s
 * decision, else {@link defaultPageUrl}; body `entry:` links follow both, so the two kinds of link
 * in one document agree. The markdown copy is the file
 * this export wrote for the target (`files`: content id to output path), under `mountPath`.
 */
export function createReferenceRendering(
  idIndex: ContentIdIndex,
  flatSchema: readonly FlatSchemaItem[],
  entryLinkUrl: EntryLinkUrlResolver | undefined,
  markdownCopies: { mountPath: string; files: ReadonlyMap<string, string> },
  linkFor?: ReferenceLinkLookup,
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
      const decided = typeof target.id === 'string' ? linkFor?.(target.id) : undefined
      return decided ?? defaultPageUrl(target, entryLinkUrl)
    },
    markdownUrl: (target) => {
      const file = typeof target.id === 'string' ? markdownCopies.files.get(target.id) : undefined
      return file ? `${mount}/${file}` : undefined
    },
  }
}
