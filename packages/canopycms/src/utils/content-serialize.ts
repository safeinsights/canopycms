/**
 * Comment-preserving serialisation for YAML content files and md/mdx frontmatter.
 *
 * ContentStore used to write a content file by stringifying a fresh plain object
 * (`yamlStringify(data)` / `matter.stringify(body, data)`). Comments live in neither the object
 * nor that round trip, so **every editor save silently deleted every comment in the file** —
 * invisible to a dev team (`canopycms sync` copies files byte-for-byte) and certain for an
 * editorial team. See `.claude/future-tasks/resolved/content-comment-loss-on-editor-save.md`.
 *
 * The fix re-serialises onto the file's OWN parsed document instead of a fresh one: nodes whose
 * value did not change are left untouched, and an untouched node keeps its attached comments
 * (and its original quoting/block style). Only what actually changed is rewritten.
 *
 * What this module does NOT do is give the file any authority over its own content. The
 * reconciler makes the document's key set match `data` exactly — a key the caller dropped
 * disappears, a key the caller kept survives whether or not the schema still knows about it.
 * Data authority stays with the payload; comments are the only thing inherited from disk. That
 * separation is deliberate: whether a surviving key SHOULD still be there is a schema question,
 * answered one layer up by `findUnknownKeys` (validation/entry-validator.ts) at the API
 * boundary, not by a serialiser that has no schema.
 */

import matter from 'gray-matter'
import {
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  stringify as yamlStringify,
  type Document,
  type Pair,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml'

/** The comment metadata every `yaml` node carries (see `NodeBase` in the `yaml` types). */
interface CommentCarrier {
  commentBefore?: string | null
  comment?: string | null
  spaceBefore?: boolean
}

/**
 * True only for a PLAIN object — one that should be reconciled key-by-key against a YAML map.
 *
 * The prototype check is load-bearing, not defensive tidiness. A looser "object and not an array"
 * test classifies a class instance as a record, and the reconciler then walks its (empty) own
 * enumerable keys and emits `{}` — silently replacing the value. A `Date` is the case that
 * actually occurs: HTTP payloads carry none, but `ContentStore.write` is also reachable from
 * server-side callers (build scripts via `createBuildCanopy`, migrations), and `d: 2024-01-15`
 * became `d: {}` on save. Anything non-plain falls through to `doc.createNode`, which serialises
 * it exactly as the pre-fix `yaml.stringify` did.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * The JS record key a YAML map key projects to, or undefined for a key that cannot be one.
 *
 * `String(...)` mirrors how parsing into a plain object projects non-string scalar keys
 * (`1: x` reads back as `{ '1': x }`). A non-scalar (complex) key — `? [a, b] : v` — has no
 * record counterpart at all; those pairs are dropped, which is what the old
 * stringify-a-fresh-object write did to them too.
 */
function recordKeyOf(keyNode: unknown): string | undefined {
  if (!isScalar(keyNode)) return undefined
  const { value } = keyNode
  if (value === null || value === undefined) return undefined
  if (typeof value === 'object') return undefined
  return String(value)
}

/**
 * Copy the comment metadata attached to a node being REPLACED onto its replacement, so a changed
 * value keeps the comments written about it.
 */
function carryComments(from: unknown, to: unknown): void {
  if (!isNode(from) || !isNode(to)) return
  const source = from as CommentCarrier
  const target = to as CommentCarrier
  if (source.commentBefore !== undefined) target.commentBefore = source.commentBefore
  if (source.comment !== undefined) target.comment = source.comment
  if (source.spaceBefore !== undefined) target.spaceBefore = source.spaceBefore
}

/**
 * Identity key for sequence alignment: the JSON form of a value.
 *
 * Returns undefined when the value cannot be keyed — a cyclic structure (reachable through YAML
 * anchors) makes `JSON.stringify` throw, and a save must never fail because of it. An unkeyable
 * item simply matches nothing and falls through to positional reconciliation.
 */
function identityKey(value: unknown): string | undefined {
  try {
    return JSON.stringify(value) ?? 'undefined'
  } catch {
    return undefined
  }
}

function nodeIdentityKey(node: unknown): string | undefined {
  if (!isNode(node)) return identityKey(node)
  try {
    return identityKey(node.toJSON())
  } catch {
    return undefined
  }
}

/**
 * Reconcile one slot of the document against the value that must occupy it, returning the node
 * to put there. `existing` is the node currently in that slot (or null/undefined for a slot that
 * did not exist).
 */
function reconcileNode(doc: Document, existing: unknown, value: unknown): unknown {
  if (isMap(existing) && isPlainRecord(value)) {
    reconcileMap(doc, existing, value)
    return existing
  }
  if (isSeq(existing) && Array.isArray(value)) {
    reconcileSeq(doc, existing, value)
    return existing
  }
  // Unchanged scalar: return the node itself, untouched. This is the case that preserves
  // comments in practice, and it also keeps the author's original quoting and block style.
  if (isScalar(existing) && Object.is(existing.value, value)) return existing

  // Changed, or a shape change (scalar <-> collection). Build a fresh node rather than mutating
  // `scalar.value` in place: an in-place type change would keep the old node's representation,
  // emitting `'42'` where the number 42 was meant.
  const fresh = doc.createNode(value)
  carryComments(existing, fresh)
  return fresh
}

/**
 * Make a map's key set match `value` exactly.
 *
 * Retained pairs are reconciled in place, so their key order and the comments attached to their
 * keys survive; keys new to `value` are appended in `value` order, which keeps the diff of a
 * save down to the lines that actually changed.
 */
function reconcileMap(
  doc: Document,
  map: YAMLMap<unknown, unknown>,
  value: Record<string, unknown>,
): void {
  // An explicitly-undefined key is NOT a key. `Object.keys` reports it, but both `JSON.stringify`
  // and `yaml.stringify` omit it — so without this filter a key present on disk and set to
  // `undefined` in the payload would be rewritten as `key: null` here while the create path
  // dropped it entirely. Same rule on both paths, so "the key set matches the payload" holds
  // exactly rather than approximately.
  const wanted = new Set(Object.keys(value).filter((key) => value[key] !== undefined))
  const seen = new Set<string>()

  const retained: Pair<unknown, unknown>[] = []
  for (const pair of map.items) {
    const key = recordKeyOf(pair.key)
    // Drop complex keys (no record counterpart), keys the caller removed, and any duplicate
    // (malformed YAML can carry two pairs with the same key; a record holds one).
    if (key === undefined || !wanted.has(key) || seen.has(key)) continue
    seen.add(key)
    pair.value = reconcileNode(doc, pair.value, value[key])
    retained.push(pair)
  }
  map.items = retained

  for (const key of Object.keys(value)) {
    if (seen.has(key) || !wanted.has(key)) continue
    map.set(doc.createNode(key), doc.createNode(value[key]))
  }
}

/**
 * Make a sequence's items match `value` exactly, aligning by VALUE first and position second.
 *
 * A list has no item identity — nothing in the payload says "this is the item that used to be
 * third" — so any alignment is a guess, and the two failure modes are not equally bad. Losing a
 * comment shows up in review as a deletion; silently MOVING a comment onto content it does not
 * describe does not, and the comments this fix exists to protect are exactly the load-bearing
 * kind ("do not delete this block") that must never end up over the wrong thing. The rules are
 * therefore ordered from most evidence to least, and stop rather than guessing:
 *
 * 1. **Exact value match** — reuse that old node whole, comments and all. This is what carries a
 *    comment through a pure reorder, instead of stranding it on whatever moved into its index.
 * 2. **Same index, still unclaimed** — reconcile against it. This is the edit-in-place case
 *    (change one field of one item), where position is real evidence.
 * 3. **Otherwise a fresh node, with no comments.**
 *
 * Rule 2 is deliberately same-index rather than "next unclaimed old node in order". The looser
 * form paired a newly-inserted item with an unrelated deleted one whenever a single save both
 * removed and added an item, so the deleted item's comments reappeared above brand-new content.
 */
function reconcileSeq(doc: Document, seq: YAMLSeq<unknown>, value: readonly unknown[]): void {
  const oldItems = seq.items

  // Old indices by identity, in order, so equal items are consumed first-come-first-served.
  const byIdentity = new Map<string, number[]>()
  oldItems.forEach((node, index) => {
    const key = nodeIdentityKey(node)
    if (key === undefined) return
    const bucket = byIdentity.get(key)
    if (bucket) bucket.push(index)
    else byIdentity.set(key, [index])
  })

  const consumed = new Set<number>()
  const matches = value.map((item) => {
    const key = identityKey(item)
    if (key === undefined) return undefined
    const bucket = byIdentity.get(key)
    while (bucket && bucket.length > 0) {
      const index = bucket.shift()
      if (index !== undefined && !consumed.has(index)) {
        consumed.add(index)
        return index
      }
    }
    return undefined
  })

  seq.items = value.map((item, index) => {
    const matched = matches[index]
    if (matched !== undefined) return oldItems[matched]
    const sameIndex = index < oldItems.length && !consumed.has(index) ? oldItems[index] : undefined
    if (sameIndex !== undefined) consumed.add(index)
    return reconcileNode(doc, sameIndex, item)
  })
}

/** Apply `data` onto a parsed document, preserving every node the data did not change. */
function applyDataToDocument(doc: Document, data: Record<string, unknown>): void {
  doc.contents = reconcileNode(doc, doc.contents, data) as Document['contents']
}

/**
 * Serialise entry data as a YAML file, carrying the comments of `existingRaw` through.
 *
 * Falls back to a plain stringify — byte-identical to the pre-fix behaviour — when there is
 * nothing to preserve (a new file) or nothing trustworthy to preserve (the bytes on disk do not
 * parse). A save must not fail because the previous content was malformed.
 */
export function serializeYaml(data: Record<string, unknown>, existingRaw?: string): string {
  if (existingRaw === undefined) return yamlStringify(data)
  const doc = parseDocument(existingRaw)
  if (doc.errors.length > 0) return yamlStringify(data)
  applyDataToDocument(doc, data)
  return doc.toString()
}

/**
 * Split a file into its raw frontmatter string, or undefined when there is nothing usable.
 *
 * Two gray-matter hazards are handled here, both of which cost a real bug when discovered:
 *
 * 1. **The options argument is load-bearing.** `matter(str)` with no options reads and writes a
 *    process-global content-keyed cache, and the object it hands back on a HIT has lost
 *    `.matter` — so the second save of the same file would silently see no frontmatter and drop
 *    every comment. Passing an options object skips the cache on both sides (see the `if
 *    (!options)` guard in gray-matter's index.js), which also keeps the write path from
 *    polluting that cache for everyone else — the same class of problem as `42aede48`.
 * 2. **It throws on malformed frontmatter.** js-yaml raises rather than returning an error list,
 *    so a file whose bytes do not parse must not be allowed to fail the save.
 *
 * Only the raw STRING is read, never `.data`, so nothing from gray-matter's own object graph can
 * alias into what gets written.
 */
function extractRawFrontmatter(raw: string): string | undefined {
  let parsed: ReturnType<typeof matter>
  try {
    parsed = matter(raw, {})
  } catch {
    return undefined
  }
  const frontmatter = (parsed as { matter?: unknown }).matter
  if (typeof frontmatter !== 'string' || frontmatter.trim() === '') return undefined
  return frontmatter
}

/**
 * Serialise an md/mdx entry, carrying the comments of `existingRaw`'s frontmatter through.
 *
 * The reconciled YAML goes back through `matter.stringify` via a custom stringify engine rather
 * than being spliced between hand-written `---` lines, so the delimiters, blank lines and
 * trailing newline stay exactly what gray-matter would have produced.
 */
export function serializeFrontmatter(
  body: string,
  data: Record<string, unknown>,
  existingRaw?: string,
): string {
  if (existingRaw === undefined) return matter.stringify(body, data)

  const existingFrontmatter = extractRawFrontmatter(existingRaw)
  if (existingFrontmatter === undefined) return matter.stringify(body, data)

  const doc = parseDocument(existingFrontmatter)
  if (doc.errors.length > 0) return matter.stringify(body, data)
  applyDataToDocument(doc, data)
  const reconciled = doc.toString()

  return matter.stringify(body, data, {
    engines: {
      yaml: {
        parse: () => ({}),
        stringify: () => reconciled,
      },
    },
  })
}
