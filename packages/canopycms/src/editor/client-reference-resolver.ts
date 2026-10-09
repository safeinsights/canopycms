import type { EntrySchema, ReferenceFieldConfig } from '../config'
import { createApiClient } from '../api/client'
import type { ApiClient } from './context'
import { flattenGroupFields } from '../utils/flatten-group-fields'
import { isValidContentId } from '../paths/validation'
import { traverseFields } from '../validation/field-traversal'

/**
 * Resolves the reference fields of a draft for live preview, at every position the server's
 * `ContentStore.resolveReferencesInData` resolves them: top level, inline groups, objects,
 * object lists and blocks, nested to any depth. `useReferenceResolution` drives it.
 */

type FormValue = Record<string, unknown>
type DataPath = readonly (string | number)[]
type Container = Record<string | number, unknown>

/** The resolve-references endpoint's per-request id cap (`MAX_RESOLVE_REFERENCE_IDS`). */
const MAX_IDS_PER_REQUEST = 100

/**
 * How long an id the endpoint omitted (it names no entry) stays cached as `null`. Its target can
 * be created afterwards, so the id is asked for again on the first edit after this.
 * @internal Exported for tests.
 */
export const MISSING_REFERENCE_TTL_MS = 10_000

interface ReferenceCacheEntry {
  /** What the endpoint returned for the id, or `null` when it omitted the id. */
  value: unknown
  /** From then on the id is fetched again; set on storing `null`, and by `expireReferences`. */
  expiresAt?: number
}

/** Resolved targets keyed by `${branch}:${id}`. */
export type ReferenceCache = Map<string, ReferenceCacheEntry>

interface ReferenceSlot {
  path: DataPath
  value: unknown
  list: boolean
}

function cacheKey(branch: string, id: string): string {
  return `${branch}:${id}`
}

function isContainer(value: unknown): value is Container {
  return typeof value === 'object' && value !== null
}

function referenceSlots(fields: EntrySchema, value: FormValue): ReferenceSlot[] {
  return traverseFields<ReferenceSlot>(
    fields,
    value,
    () => [],
    '',
    ({ fields: containerFields, data, dataPath }) =>
      flattenGroupFields(containerFields)
        .filter((field): field is ReferenceFieldConfig => field.type === 'reference')
        .map((field) => ({
          path: [...dataPath, field.name],
          value: data[field.name],
          list: field.list === true,
        })),
  )
}

/** A slot's ids, by the server's rule; never a malformed one, which fails the whole request. */
function slotIds(slot: ReferenceSlot): string[] {
  const ids =
    typeof slot.value === 'string'
      ? [slot.value]
      : slot.list && Array.isArray(slot.value)
        ? slot.value.filter((id): id is string => typeof id === 'string')
        : []
  return ids.filter(isValidContentId)
}

/** The ids in the draft with no fresh cache entry: never fetched, or expired. */
export function idsToFetch(
  fields: EntrySchema,
  value: FormValue,
  branch: string,
  cache: ReferenceCache,
  now: number,
): string[] {
  const ids = new Set<string>()
  for (const slot of referenceSlots(fields, value)) {
    for (const id of slotIds(slot)) {
      const entry = cache.get(cacheKey(branch, id))
      if (!entry || (entry.expiresAt !== undefined && entry.expiresAt <= now)) ids.add(id)
    }
  }
  return [...ids]
}

/**
 * Resolve `ids` in batches of the endpoint's cap. Every requested id is in the result: the
 * endpoint's value, or `null` for an id it omitted. Throws when any batch fails, so a transient
 * error caches nothing and the ids stay pending.
 */
export async function fetchReferences(
  ids: readonly string[],
  branch: string,
  apiClient?: ApiClient,
): Promise<Map<string, unknown>> {
  const client = apiClient ?? createApiClient()
  const batches: string[][] = []
  for (let i = 0; i < ids.length; i += MAX_IDS_PER_REQUEST) {
    batches.push(ids.slice(i, i + MAX_IDS_PER_REQUEST))
  }
  const responses = await Promise.all(
    batches.map((batch) => client.content.resolveReferences({ branch }, { ids: batch })),
  )

  const found = new Map<string, unknown>()
  responses.forEach((response, index) => {
    if (!response.ok || !response.data) {
      throw new Error(`Resolving references failed with status ${response.status}`)
    }
    const { resolved } = response.data
    for (const id of batches[index]) {
      found.set(id, Object.prototype.hasOwnProperty.call(resolved, id) ? resolved[id] : null)
    }
  })
  return found
}

/** Cache what {@link fetchReferences} returned; an omitted id expires after the missing TTL. */
export function storeReferences(
  cache: ReferenceCache,
  branch: string,
  found: Map<string, unknown>,
  now: number,
): void {
  for (const [id, value] of found) {
    cache.set(
      cacheKey(branch, id),
      value === null ? { value: null, expiresAt: now + MISSING_REFERENCE_TTL_MS } : { value },
    )
  }
}

/**
 * Mark every entry expired, so each id is fetched again while its cached value keeps showing.
 * Used when the open entry changes, since a target may have been edited in the meantime.
 */
export function expireReferences(cache: ReferenceCache): void {
  for (const entry of cache.values()) entry.expiresAt = 0
}

/**
 * Write `leaf` at `path`, copying each container on the way the first time it is touched, so
 * the input is never mutated and untouched subtrees keep their identity.
 */
function setCopied(
  root: FormValue,
  path: DataPath,
  leaf: unknown,
  copies: WeakSet<object>,
): FormValue {
  const copy = (node: Container): Container => {
    if (copies.has(node)) return node
    const next = (Array.isArray(node) ? [...node] : { ...node }) as Container
    copies.add(next)
    return next
  }
  const nextRoot = copy(root)
  let node = nextRoot
  for (const key of path.slice(0, -1)) {
    const child = node[key]
    if (!isContainer(child)) return nextRoot
    const next = copy(child)
    node[key] = next
    node = next
  }
  node[path[path.length - 1]] = leaf
  return nextRoot as FormValue
}

/**
 * Write `leaf` at `path` in a fresh tree, creating each missing level. An array is created as
 * long as `source`'s array at that path, with an empty object per item, so it has no holes.
 */
function setCreating(root: FormValue, path: DataPath, leaf: unknown, source: FormValue): void {
  let node: Container = root
  let from: unknown = source
  path.slice(0, -1).forEach((key) => {
    from = isContainer(from) ? from[key] : undefined
    let child = node[key]
    if (!isContainer(child)) {
      child = Array.isArray(from) ? Array.from(from, () => ({})) : {}
      node[key] = child
    }
    node = child as Container
  })
  node[path[path.length - 1]] = leaf
}

/**
 * The draft as the preview sees it, computed synchronously from the cache.
 *
 * Each reference becomes its cached target, or `null` while it has none (still resolving, an
 * id that names no entry, or a malformed id). A list field's array maps element by element, a
 * non-string element to `null`; anything else is left as the form holds it, as on the server.
 * `loadingState` holds a boolean only at reference positions, `true` while resolving, at the
 * reference's own path (`boolean[]` for a list).
 */
export function applyReferenceCache(
  fields: EntrySchema,
  value: FormValue,
  branch: string,
  cache: ReferenceCache,
): { resolvedValue: FormValue; loadingState: FormValue } {
  let resolvedValue = value
  const loadingState: FormValue = {}
  const copies = new WeakSet<object>()

  const lookup = (id: unknown): { value: unknown; loading: boolean } => {
    if (typeof id !== 'string' || !isValidContentId(id)) return { value: null, loading: false }
    const entry = cache.get(cacheKey(branch, id))
    return entry ? { value: entry.value, loading: false } : { value: null, loading: true }
  }

  for (const slot of referenceSlots(fields, value)) {
    if (typeof slot.value === 'string' && slot.value) {
      const { value: target, loading } = lookup(slot.value)
      resolvedValue = setCopied(resolvedValue, slot.path, target, copies)
      setCreating(loadingState, slot.path, loading, value)
    } else if (slot.list && Array.isArray(slot.value)) {
      const items = slot.value.map(lookup)
      if (slot.value.length > 0) {
        resolvedValue = setCopied(
          resolvedValue,
          slot.path,
          items.map((item) => item.value),
          copies,
        )
      }
      setCreating(
        loadingState,
        slot.path,
        items.map((item) => item.loading),
        value,
      )
    } else {
      setCreating(loadingState, slot.path, false, value)
    }
  }

  return { resolvedValue, loadingState }
}
