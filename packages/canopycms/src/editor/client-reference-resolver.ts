import type { EntrySchema } from '../config'
import { createApiClient } from '../api/client'
import type { ApiClient } from './context'
import { flattenGroupFields } from '../utils/flatten-group-fields'
import { traverseFields } from '../validation/field-traversal'

/**
 * Resolves the reference fields of a draft for live preview, at every position the server's
 * `ContentStore.resolveReferencesInData` resolves them: top level, inline groups, objects,
 * object lists and blocks, nested to any depth. `useReferenceResolution` drives it.
 *
 * Plain functions rather than a hook: the fetch runs inside a debounced `setTimeout`, where a
 * hook cannot be called, so the caller passes in the context's API client.
 */

type FormValue = Record<string, unknown>
type DataPath = readonly (string | number)[]
/** An object or array in the draft; both are read and written by key. */
type Container = Record<string | number, unknown>

/** The resolve-references endpoint's per-request id cap (`MAX_RESOLVE_REFERENCE_IDS`). */
const MAX_IDS_PER_REQUEST = 100

/**
 * How long an id the endpoint omitted (it names no entry) stays cached as `null`. Its target can
 * be created afterwards, so the id is asked for again on the first edit after this.
 */
export const MISSING_REFERENCE_TTL_MS = 10_000

export interface ReferenceCacheEntry {
  /** What the endpoint returned for the id, or `null` when it omitted the id. */
  value: unknown
  /** Set only on a `null` entry: from then on the id is fetched again. */
  expiresAt?: number
}

/** Resolved targets keyed by `${branch}:${id}`. */
export type ReferenceCache = Map<string, ReferenceCacheEntry>

/** One reference field in the draft: where it sits and what the form holds there. */
interface ReferenceSlot {
  path: DataPath
  value: unknown
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
        .filter((field) => field.type === 'reference')
        .map((field) => ({ path: [...dataPath, field.name], value: data[field.name] })),
  )
}

function slotIds(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : []
  if (Array.isArray(value)) {
    return value.filter((id): id is string => typeof id === 'string' && id !== '')
  }
  return []
}

/** The ids in the draft with no usable cache entry: never fetched, or missing and expired. */
export function idsToFetch(
  fields: EntrySchema,
  value: FormValue,
  branch: string,
  cache: ReferenceCache,
  now: number,
): string[] {
  const ids = new Set<string>()
  for (const slot of referenceSlots(fields, value)) {
    for (const id of slotIds(slot.value)) {
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

/** Write `leaf` at `path` in a fresh tree, creating an array or object for each missing level. */
function setCreating(root: FormValue, path: DataPath, leaf: unknown): void {
  let node: Container = root
  path.slice(0, -1).forEach((key, index) => {
    let child = node[key]
    if (!isContainer(child)) {
      child = typeof path[index + 1] === 'number' ? [] : {}
      node[key] = child
    }
    node = child as Container
  })
  node[path[path.length - 1]] = leaf
}

/**
 * The draft as the preview sees it, computed synchronously from the cache.
 *
 * Each reference becomes its cached target, or `null` while it has none (still resolving, or
 * an id that names no entry). A list maps element by element. `loadingState` holds `true` at
 * each position still resolving, at the same path as the reference (`boolean[]` for a list),
 * and nothing at positions that are not references.
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
    if (typeof id !== 'string') return { value: id, loading: false }
    if (id === '') return { value: null, loading: false }
    const entry = cache.get(cacheKey(branch, id))
    return entry ? { value: entry.value, loading: false } : { value: null, loading: true }
  }

  for (const slot of referenceSlots(fields, value)) {
    if (typeof slot.value === 'string' && slot.value) {
      const { value: target, loading } = lookup(slot.value)
      resolvedValue = setCopied(resolvedValue, slot.path, target, copies)
      setCreating(loadingState, slot.path, loading)
    } else if (Array.isArray(slot.value)) {
      const items = slot.value.map(lookup)
      if (slot.value.some((id) => typeof id === 'string')) {
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
      )
    } else {
      setCreating(loadingState, slot.path, false)
    }
  }

  return { resolvedValue, loadingState }
}
