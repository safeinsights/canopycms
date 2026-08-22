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
  isCollection,
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

import { isBlockStructuralKey } from '../validation/block-structural-keys'

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
 *
 * Known residual, and the reason this is a prototype check rather than a `toJSON` check: a PLAIN
 * object carrying its own `toJSON` is still walked as a record here, while `createNode` (the
 * create path, and the scalar-slot path) would call `toJSON` instead — so the same payload can
 * serialise differently depending on what is currently on disk, and a `toJSON` function value
 * makes `createNode` throw. Unreachable over HTTP, since JSON payloads carry no functions; a loud
 * failure rather than corruption if a server-side caller ever hits it.
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

function nodePlainValue(node: unknown): unknown {
  if (!isNode(node)) return node
  try {
    return node.toJSON()
  } catch {
    return undefined
  }
}

function nodeIdentityKey(node: unknown): string | undefined {
  const plain = nodePlainValue(node)
  return plain === undefined && isNode(node) ? undefined : identityKey(plain)
}

/**
 * How far {@link sharesFieldEvidence} descends into nested records before giving up.
 *
 * Termination does not actually depend on this — it is defence in depth, deliberately kept
 * because the alternative is depending on two other layers behaving as expected, which is the
 * shape of assumption that produced the bug {@link looksLikeSameItem} documents. Spelling out
 * what the cap is and is not doing, since the obvious guess is wrong in both directions:
 *
 * - A cyclic PAYLOAD is genuinely reachable (`ContentStore.write` is callable server-side with
 *   arbitrary objects, which is why `identityKey` guards `JSON.stringify` at all). It cannot run
 *   away here on its own, because the descent below only happens when BOTH sides are records.
 * - The on-disk side cannot supply the matching cycle: `existing` comes from `yaml`'s `toJSON()`,
 *   and a self-referential anchor (`- &b {self: *b}`) does not round-trip into a cyclic JS
 *   object — `toJSON` degrades the unresolvable alias to a plain `{ source }` marker (verified
 *   against the `yaml` version pinned here; the cycle case `identityKey`'s comment describes is
 *   the `JSON.stringify` hazard, not this one).
 *
 * So the real bound today is the finite depth of the parsed document — a guarantee owned by
 * `yaml`, not by this module. The cap makes it local and explicit, and incidentally bounds cost
 * on pathologically nested content. Real content bottoms out far shallower: a block is item ->
 * `value` -> fields, and an object field inside one adds a level. Exceeding the cap simply means
 * "no evidence found", which drops a comment rather than risking a move — the safe direction.
 */
const EVIDENCE_MAX_DEPTH = 6

/**
 * Does `value` share at least one non-structural leaf with `existing` — i.e. is there any field
 * whose value an edit left alone?
 *
 * Two things this looks past, both learned the hard way:
 *
 * - **Block discriminators are not evidence.** `template` (and the inline shape's `_type`) names
 *   a block's TEMPLATE, so every `hero` on the page carries the same one. Counting it made the
 *   check below true for any two blocks of the same kind. See `../validation/block-structural-keys`.
 * - **A block's real fields are one level down.** The canonical shape is
 *   `{ template, value: { ...fields } }`, so comparing top-level values compares `value` whole —
 *   which differs the moment ANY field in it changes. Together with the point above that left a
 *   block with no reachable evidence at all, i.e. "drop every block comment on every edit". So
 *   nested records are descended into.
 *
 * Arrays are compared whole rather than element-wise, deliberately. A list has no item identity
 * — that is the premise `reconcileSeq` is built on — so pairing elements by index to harvest
 * evidence would be the same positional guess this module exists to refuse, just one level down.
 * The cost is that a record whose only field is a list loses its comment when that list changes,
 * which is the single-field residual documented on {@link looksLikeSameItem}, not a new class.
 */
function sharesFieldEvidence(
  existing: Record<string, unknown>,
  value: Record<string, unknown>,
  depth: number,
): boolean {
  for (const key of Object.keys(value)) {
    if (isBlockStructuralKey(key)) continue
    if (!Object.prototype.hasOwnProperty.call(existing, key)) continue
    const before = existing[key]
    const after = value[key]
    // Descending is only ever an EXTRA chance to find evidence: the whole-value comparison below
    // still runs, so a pair of structurally-empty records ({} vs {}) still matches on identity
    // even though there is no leaf inside them to match on.
    if (
      depth < EVIDENCE_MAX_DEPTH &&
      isPlainRecord(before) &&
      isPlainRecord(after) &&
      sharesFieldEvidence(before, after, depth + 1)
    ) {
      return true
    }
    const beforeKey = identityKey(before)
    if (beforeKey !== undefined && beforeKey === identityKey(after)) return true
  }
  return false
}

/**
 * Is `value` plausibly an EDITED version of the item currently at this index, rather than a
 * different item that merely landed on the same index?
 *
 * Position alone is not evidence. A save that replaces one list item wholesale — delete this
 * block, add that one — leaves the new item sitting exactly where the old one was, and pairing
 * them purely by index moved the old item's comments onto content they do not describe. For the
 * comments this change exists to protect ("do not delete this block") that is worse than losing
 * them, because a lost comment reads as a deletion in review while a moved one reads as intact.
 *
 * Records carry usable evidence: an edit changes some fields and leaves others alone, so one
 * surviving field value means "same item, edited". The evidence has to be a real FIELD, though.
 * An earlier version of this rule accepted any shared key/value pair on the reasoning that "a
 * wholesale replacement shares nothing" — true of arbitrary records, false of this CMS's block
 * shape, where `template: <name>` is a category label every block of that kind carries. A save
 * that deleted one `hero` and edited the next shifted the survivor onto the deleted item's
 * index, and the discriminator alone was enough to pair them: the deleted block's "keep this
 * verbatim" comment silently migrated onto unrelated content. So the module was failing in the
 * exact direction it declared unacceptable, through the case it assumed could not arise.
 * {@link sharesFieldEvidence} is therefore discriminator-blind and record-deep.
 *
 * Scalars carry no evidence at all, so they keep the plain same-index rule — an edited string in
 * a list is overwhelmingly the common case there, and a short annotation on a scalar is far less
 * load-bearing than a block comment. That residual is unchanged by the above and is pinned as
 * accepted rather than fixed: giving scalars the same treatment would drop the comment on every
 * ordinary one-line edit, which is a large, certain loss traded against a small, speculative one.
 *
 * One shared field is still the bar, not two. Raising it would take a two-field block — the
 * common size — from "keeps its comment when one field is edited" to "never keeps it", which
 * empties the rule out for the shape it was just repaired for; the discriminator was the thing
 * making one pair meaningless, and it is now excluded.
 *
 * The residuals, deliberately accepted: a record whose every field changed shares nothing, so
 * its comment is dropped rather than risked (this now includes a block edited in ALL its fields,
 * which previously kept its comment via the discriminator — a deliberate move toward the losing
 * side of the trade-off); and a genuine schema field NAMED `template` or `_type` is not counted
 * as evidence, which can only ever drop a comment, never move one.
 */
function looksLikeSameItem(node: unknown, value: unknown): boolean {
  const existing = nodePlainValue(node)
  // No record evidence available on either side — fall back to position.
  if (!isPlainRecord(existing) || !isPlainRecord(value)) return true

  return sharesFieldEvidence(existing, value, 0)
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
  // Comments move with a changed VALUE, but not off a replaced STRUCTURE. `yaml` attaches a
  // comment written above a collection's first entry to the collection node itself (the same
  // rule that makes a leading list comment a list-head comment), so that node's comments are
  // about its innards. Carrying them onto whatever replaces the collection put "# FLAG: explains
  // the heading below" above a bare string that has no heading -- a comment over content it does
  // not describe, which this module treats as worse than losing it. A comment written above the
  // KEY is unaffected either way: it lives on the pair's key node, which is never replaced here.
  if (!isCollection(existing)) carryComments(existing, fresh)
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
 * 2. **Same index, still unclaimed, and recognisably the same item** (`looksLikeSameItem`) —
 *    reconcile against it. This is the edit-in-place case.
 * 3. **Otherwise a fresh node, with no comments.**
 *
 * Rule 2 is deliberately same-index rather than "next unclaimed old node in order": the looser
 * form paired a newly-inserted item with an unrelated deleted one whenever one save both removed
 * and added an item. Position alone is still not enough, though — a wholesale replacement lands
 * on the index it replaced — which is why rule 2 also demands evidence of identity.
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
    // `consumed` holds OLD indices claimed by rule 1, so this asks "is the node that sits at my
    // index still unclaimed?". Each iteration owns a distinct index, so no bookkeeping is needed
    // here — a candidate cannot be taken twice.
    const candidate = index < oldItems.length && !consumed.has(index) ? oldItems[index] : undefined
    const sameItem =
      candidate !== undefined && looksLikeSameItem(candidate, item) ? candidate : undefined
    return reconcileNode(doc, sameItem, item)
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
