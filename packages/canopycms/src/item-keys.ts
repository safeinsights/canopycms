import type {
  BlockFieldConfig,
  FieldConfig,
  InlineGroupFieldConfig,
  ObjectFieldConfig,
} from './config'
import { isPlainRecord, resolveBlockItem } from './validation/field-traversal'
import { formatCanopyPath, parseCanopyPath, type CanopyPathSegment } from './editor/canopy-path'

/**
 * The key each object-list item and block carries in content, naming that item among its list's
 * items for as long as it exists: a move or an edit keeps it, a copy gets a new one. Field comment
 * threads name the items on their path by it (`CommentThread.itemKeys`). Beside `template` on a
 * block, never inside its `value`; a schema may not define a field of this name.
 *
 * Dependency-free: the editor and the server both use this module.
 */
export const ITEM_KEY = '_key'

const ITEM_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** A usable item key: 1-64 letters, digits, `_` or `-`, starting with a letter or digit. */
export const isItemKey = (value: unknown): value is string =>
  typeof value === 'string' && ITEM_KEY_PATTERN.test(value)

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** A new random item key: 12 Base58 characters. */
export function mintItemKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => BASE58[b % 58]).join('')
}

/** cyrb53: a fast, well-mixed 53-bit string hash. Not cryptographic, and needn't be. */
function hash53(text: string): number {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

/** `h` and the Base58 hash of an item as it was read, before any key was added inside it. */
function contentKey(item: Record<string, unknown>): string {
  let n = hash53(JSON.stringify(item))
  let out = ''
  do {
    out = BASE58[n % 58] + out
    n = Math.floor(n / 58)
  } while (n > 0)
  return `h${out}`
}

/**
 * How `withItemKeys` keys an item that lacks a usable key, or repeats one an earlier item of its
 * list holds:
 * - `content`: from a hash of the item, so every reader and writer of the same file names it
 *   alike before a save writes the key down, and an item added to the file later never inherits
 *   a key a removed one held unless it is the same content;
 * - `random`: a fresh key;
 * - `fresh`: a fresh key for EVERY item, keyed or not, as a copy needs.
 */
export type ItemKeyFill = 'content' | 'random' | 'fresh'

type ListField = ObjectFieldConfig | BlockFieldConfig

const isListField = (field: FieldConfig): field is ListField =>
  field.type === 'block' || (field.type === 'object' && !!(field as ObjectFieldConfig).list)

/**
 * `data` with every object-list item and block keyed, each unique in its list, nested lists
 * included; the same object when nothing needed a key. A usable key is kept unless `fill` is
 * `fresh`.
 */
export function withItemKeys(
  fields: readonly FieldConfig[],
  data: Record<string, unknown>,
  fill: ItemKeyFill,
): Record<string, unknown> {
  let out = data
  for (const field of fields) {
    if (field.type === 'group') {
      out = withItemKeys((field as InlineGroupFieldConfig).fields, out, fill)
      continue
    }
    const value = out[field.name]
    let next: unknown = value
    if (isListField(field)) {
      if (Array.isArray(value)) next = keyList(field, value, fill)
    } else if (field.type === 'object' && isPlainRecord(value)) {
      next = withItemKeys((field as ObjectFieldConfig).fields ?? [], value, fill)
    }
    if (next !== value) out = { ...out, [field.name]: next }
  }
  return out
}

/** `item`, a copy about to join `field`'s list, with fresh keys for it and every item inside it. */
export function withFreshItemKeys<T>(field: ListField, item: T): T {
  return keyList(field, [item], 'fresh')[0] as T
}

function keyList(field: ListField, items: readonly unknown[], fill: ItemKeyFill): unknown[] {
  const held = new Set<string>()
  if (fill !== 'fresh') {
    for (const item of items) {
      if (isPlainRecord(item) && isItemKey(item[ITEM_KEY])) held.add(item[ITEM_KEY])
    }
  }
  const kept = new Set<string>()
  let changed = false
  const out = items.map((item) => {
    if (!isPlainRecord(item)) return item
    let next = keyInside(field, item, fill)
    const own = item[ITEM_KEY]
    if (fill !== 'fresh' && isItemKey(own) && !kept.has(own)) {
      kept.add(own)
    } else {
      const key = fill === 'content' ? unheld(contentKey(item), held) : mintItemKey()
      held.add(key)
      kept.add(key)
      next = { ...next, [ITEM_KEY]: key }
    }
    if (next !== item) changed = true
    return next
  })
  return changed ? out : (items as unknown[])
}

/** `key`, or with a suffix when another item of the list already holds it (identical items). */
function unheld(key: string, held: ReadonlySet<string>): string {
  let out = key
  for (let n = 2; held.has(out); n++) out = `${key}-${n}`
  return out
}

/** The item with the lists inside it keyed. */
function keyInside(
  field: ListField,
  item: Record<string, unknown>,
  fill: ItemKeyFill,
): Record<string, unknown> {
  if (field.type !== 'block') {
    return withItemKeys((field as ObjectFieldConfig).fields ?? [], item, fill)
  }
  const resolved = resolveBlockItem(field as BlockFieldConfig, item)
  if (!resolved) return item
  const data = withItemKeys(resolved.fields, resolved.data, fill)
  if (data === resolved.data) return item
  return resolved.data === item ? data : { ...item, value: data }
}

const findField = (fields: readonly FieldConfig[], name: string): FieldConfig | undefined => {
  for (const field of fields) {
    if (field.type === 'group') {
      const inGroup = findField((field as InlineGroupFieldConfig).fields, name)
      if (inGroup) return inGroup
    } else if (field.name === name) {
      return field
    }
  }
  return undefined
}

/**
 * Walks `canopyPath` through `value` by schema, calling `atIndex` with each list index on the path
 * and that list's items; it returns the index to continue with, or undefined to stop. Returns the
 * path walked, or undefined when the walk stopped or the value has no such path.
 */
function walkPath(
  fields: readonly FieldConfig[],
  value: Record<string, unknown>,
  canopyPath: string,
  atIndex: (index: number, items: readonly unknown[], depth: number) => number | undefined,
): CanopyPathSegment[] | undefined {
  const segments = parseCanopyPath(canopyPath)
  const out: CanopyPathSegment[] = []
  let scope: readonly FieldConfig[] = fields
  let record: Record<string, unknown> | undefined = value
  let depth = 0
  for (let i = 0; i < segments.length; i++) {
    const name = segments[i]
    if (typeof name !== 'string') return undefined
    const field = findField(scope, name)
    out.push(name)
    if (!field || i === segments.length - 1) {
      if (!field) return undefined
      continue
    }
    const node: unknown = record?.[name]
    if (isListField(field)) {
      const index = segments[i + 1]
      if (typeof index !== 'number' || !Array.isArray(node)) return undefined
      const at = atIndex(index, node, depth)
      if (at === undefined) return undefined
      depth += 1
      out.push(at)
      i += 1
      const item: unknown = node[at]
      if (!isPlainRecord(item)) return undefined
      if (field.type === 'block') {
        const resolved = resolveBlockItem(field as BlockFieldConfig, item)
        if (!resolved) return undefined
        scope = resolved.fields
        record = resolved.data
      } else {
        scope = (field as ObjectFieldConfig).fields ?? []
        record = item
      }
    } else if (field.type === 'object') {
      scope = (field as ObjectFieldConfig).fields ?? []
      record = isPlainRecord(node) ? node : undefined
    } else {
      return undefined
    }
  }
  return out
}

/**
 * The keys of the list items on `canopyPath` in `value`, outermost first: what a new field thread
 * stores to name them. Undefined when an item on the path has no usable key or the path isn't
 * there.
 */
export function itemKeysOnPath(
  fields: readonly FieldConfig[],
  value: Record<string, unknown>,
  canopyPath: string,
): string[] | undefined {
  const keys: string[] = []
  const walked = walkPath(fields, value, canopyPath, (index, items) => {
    const item = items[index]
    const key = isPlainRecord(item) ? item[ITEM_KEY] : undefined
    if (!isItemKey(key)) return undefined
    keys.push(key)
    return index
  })
  return walked ? keys : undefined
}

/**
 * Where a field thread made at `canopyPath` on the items named by `itemKeys` is in `value` now:
 * its path with each index replaced by that item's current one, or `null` when one of the items
 * is gone. A path with no keys (one through no list) is returned as it is.
 */
export function resolveThreadPath(
  fields: readonly FieldConfig[],
  value: Record<string, unknown>,
  canopyPath: string,
  itemKeys: readonly string[] | undefined,
): string | null {
  if (!itemKeys || itemKeys.length === 0) return canopyPath
  let missing = false
  const walked = walkPath(fields, value, canopyPath, (_index, items, depth) => {
    const key = itemKeys[depth]
    const at = items.findIndex((item) => isPlainRecord(item) && item[ITEM_KEY] === key)
    if (key === undefined || at === -1) {
      missing = true
      return undefined
    }
    return at
  })
  // A walk that can't reach an item, its enclosing object cleared or its block's template gone,
  // has lost it just as surely as a removal.
  if (missing || !walked) return null
  return formatCanopyPath(walked)
}
