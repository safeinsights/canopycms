/**
 * Comment-preserving serialisation for YAML content files and md/mdx frontmatter.
 *
 * Stringifying a fresh plain object (`yamlStringify(data)` / `matter.stringify(body, data)`)
 * deletes every comment in the file, because comments live in neither the object nor that round
 * trip. So these functions re-serialise onto the file's OWN parsed document: a node whose value
 * did not change is left untouched, and an untouched node keeps its attached comments and its
 * original quoting/block style. Only what actually changed is rewritten, and
 * `yaml-source-splice.ts` writes it into the file's own text, so untouched lines keep their bytes
 * wherever it can vouch for the result.
 *
 * The file gets no authority over its own content. The reconciler makes the document's key set
 * match `data` exactly — a key the caller dropped disappears, a key the caller kept survives
 * whether or not the schema still knows about it. Data authority stays with the payload;
 * comments are the only thing inherited from disk. Whether a surviving key SHOULD still be there
 * is a schema question, answered one layer up by `findUnknownKeys`
 * (validation/entry-validator.ts) at the API boundary, not by a schema-blind serialiser.
 */

import { isDeepStrictEqual } from 'node:util'

import matter from 'gray-matter'
import {
  isCollection,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  Scalar,
  stringify as yamlStringify,
  type Document,
  type Pair,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml'

import { isBlockStructuralKey } from '../validation/block-structural-keys'
import { createDebugLogger } from './debug'
import { getErrorMessage } from './error'
import { preserveMarkdownSource, type MarkdownBodyFormat } from './markdown-body-splice'
import { snapshotDocument, spliceSource, withSourceLineEndings } from './yaml-source-splice'

const log = createDebugLogger({ prefix: 'ContentSerialize' })

/** State one reconcile threads through: the document, and which node replaced which. */
interface ReconcileContext {
  readonly doc: Document
  /** Each node created for an existing slot, mapped to the node it replaced. */
  readonly replaced: WeakMap<object, unknown>
  /** Fresh scalars given the replaced scalar's style, which a re-print may have to take back. */
  readonly restyled: Scalar[]
}

/** The comment metadata every `yaml` node carries (see `NodeBase` in the `yaml` types). */
interface CommentCarrier {
  commentBefore?: string | null
  comment?: string | null
  spaceBefore?: boolean
}

/**
 * True only for a PLAIN object — one that should be reconciled key-by-key against a YAML map.
 *
 * The prototype check is load-bearing. A looser "object and not an array" test classifies a class
 * instance as a record, and the reconciler then walks its (empty) own enumerable keys and emits
 * `{}`, silently replacing the value. `Date` is the case that occurs: HTTP payloads carry none,
 * but `ContentStore.write` is also reachable server-side (build scripts via `createBuildCanopy`,
 * migrations), where a date field came back as `{}`. Anything non-plain falls through to
 * `doc.createNode`, which serialises it exactly as a plain `yaml.stringify` would.
 *
 * Residual, and the reason this is a prototype rather than a `toJSON` check: a PLAIN object
 * carrying its own `toJSON` is walked as a record here while `createNode` would call `toJSON`,
 * so the same payload can serialise differently depending on what is on disk, and a `toJSON`
 * function value makes `createNode` throw. Unreachable over HTTP (JSON payloads carry no
 * functions), and a loud failure rather than corruption if a server-side caller hits it.
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
 * record counterpart at all; those pairs are dropped.
 */
function recordKeyOf(keyNode: unknown): string | undefined {
  if (!isScalar(keyNode)) return undefined
  const { value } = keyNode
  if (value === null || value === undefined) return undefined
  if (typeof value === 'object') return undefined
  return String(value)
}

/**
 * Copy a REPLACED node's comment metadata onto its replacement, so a changed value keeps the
 * comments written about it.
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
 * Identity key for sequence alignment: the JSON form of a value. Undefined when the value cannot
 * be keyed — a cyclic structure (reachable through YAML anchors) makes `JSON.stringify` throw,
 * and a save must never fail because of it. An unkeyable item matches nothing and falls through
 * to positional reconciliation.
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
 * Termination does not depend on it — the cap is defence in depth. A cyclic PAYLOAD is reachable
 * server-side (which is why `identityKey` guards `JSON.stringify`) but cannot run away here: the
 * descent happens only when BOTH sides are records, and the on-disk side comes from `yaml`'s
 * `toJSON()`, which degrades an unresolvable self-referential anchor to a plain `{ source }`
 * marker rather than a cyclic object. The real bound is the parsed document's finite depth, a
 * guarantee owned by `yaml`; the cap makes it local and bounds cost on pathologically nested
 * content. Exceeding it means "no evidence found", which drops a comment rather than risking a
 * move — the safe direction.
 */
const EVIDENCE_MAX_DEPTH = 6

/**
 * Does `value` share at least one non-structural leaf with `existing` — i.e. is there any field
 * whose value an edit left alone?
 *
 * Two things it looks past, and both halves are required together:
 *
 * - **Block discriminators are not evidence.** `template` (and the inline shape's `_type`) names
 *   a block's TEMPLATE, so every `hero` on the page carries the same one; counting it makes the
 *   check true for any two blocks of the same kind. See `../validation/block-structural-keys`.
 * - **A block's real fields are one level down.** The canonical shape is
 *   `{ template, value: { ...fields } }`, so comparing top-level values compares `value` whole,
 *   which differs the moment ANY field in it changes — with the point above, that leaves a block
 *   no reachable evidence at all, i.e. drops every block comment on every edit. So nested
 *   records are descended into.
 *
 * Arrays are compared whole rather than element-wise: pairing elements by index to harvest
 * evidence would be the same positional guess {@link reconcileSeq} refuses, one level down.
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
    // Descending is only an EXTRA chance to find evidence: the whole-value comparison below still
    // runs, so a pair of structurally-empty records ({} vs {}) still matches on identity.
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
 * different item that merely landed on the same index? Position alone is not evidence: a save
 * that replaces one list item wholesale leaves the new item exactly where the old one was, and
 * {@link reconcileSeq} explains why pairing them anyway is the worse failure.
 *
 * Records carry usable evidence: an edit changes some fields and leaves others alone, so one
 * surviving field value means "same item, edited". The evidence has to be a real FIELD, which is
 * why {@link sharesFieldEvidence} is discriminator-blind and record-deep — `template: <name>` is
 * a category label every block of that kind carries, so counting it pairs a block deleted from an
 * index with the unrelated survivor that shifted onto it, migrating a "keep this verbatim"
 * comment onto other content. One shared field is the bar, not two: raising it would take a
 * two-field block — the common size — from "keeps its comment when one field is edited" to
 * "never keeps it".
 *
 * Scalars carry no evidence and keep the plain same-index rule: an edited string in a list is the
 * common case, a short scalar annotation is far less load-bearing than a block comment, and
 * treating scalars the same way would drop the comment on every ordinary one-line edit.
 *
 * Residuals, deliberately accepted: a record whose every field changed shares nothing, so its
 * comment is dropped rather than risked; and a genuine schema field NAMED `template` or `_type`
 * is not counted as evidence, which can only drop a comment, never move one.
 */
function looksLikeSameItem(node: unknown, value: unknown): boolean {
  const existing = nodePlainValue(node)
  // No record evidence available on either side — fall back to position.
  if (!isPlainRecord(existing) || !isPlainRecord(value)) return true

  return sharesFieldEvidence(existing, value, 0)
}

/**
 * Reconcile one slot of the document against the value that must occupy it, returning the node to
 * put there. `existing` is the node in that slot, or null/undefined for a slot that did not exist.
 */
function reconcileNode(ctx: ReconcileContext, existing: unknown, value: unknown): unknown {
  if (isMap(existing) && isPlainRecord(value)) {
    reconcileMap(ctx, existing, value)
    return existing
  }
  if (isSeq(existing) && Array.isArray(value)) {
    reconcileSeq(ctx, existing, value)
    return existing
  }
  // Unchanged scalar: return the node itself, untouched. This is the case that preserves comments
  // in practice, and it keeps the author's original quoting and block style.
  if (isScalar(existing) && Object.is(existing.value, value)) return existing

  // Changed, or a shape change (scalar <-> collection). A fresh node rather than mutating
  // `scalar.value` in place, which would keep the old node's representation and emit `'42'` where
  // the number 42 was meant.
  const fresh = ctx.doc.createNode(value)
  if (isNode(existing)) ctx.replaced.set(fresh, existing)
  if (isScalar(existing) && isScalar(fresh) && typeof value === 'string') {
    const style = carriedStyle(existing, value)
    if (style !== undefined) {
      fresh.type = style
      ctx.restyled.push(fresh)
    }
  }
  // Comments move with a changed VALUE, but not off a replaced STRUCTURE. `yaml` attaches a
  // comment written above a collection's first entry to the collection node itself, so that
  // node's comments are about its innards; carrying them onto whatever replaces the collection
  // puts a comment over content it does not describe, which this module treats as worse than
  // losing it. A comment written above the KEY is unaffected: it lives on the pair's key node,
  // which is never replaced here.
  if (!isCollection(existing)) carryComments(existing, fresh)
  return fresh
}

/**
 * The style a changed string inherits from the string it replaces: its quoting, or its block
 * style (`>-`, `|`) unless the new value has no content or leads with whitespace, which `yaml`
 * can print lossily in a block (`"   "` reads back as `""`). Never `PLAIN`: forcing it stops `yaml` choosing a
 * block for a multi-line value, and some (`Requirements:\nBring a laptop`) then print as
 * unparseable YAML. An unset style is plain where plain is safe.
 */
function carriedStyle(existing: Scalar, value: string): Scalar.Type | undefined {
  if (typeof existing.value !== 'string') return undefined
  switch (existing.type) {
    case Scalar.QUOTE_DOUBLE:
    case Scalar.QUOTE_SINGLE:
      return existing.type
    case Scalar.BLOCK_FOLDED:
    case Scalar.BLOCK_LITERAL:
      return /\S/.test(value) && !/^\s/.test(value) ? existing.type : undefined
    default:
      return undefined
  }
}

/**
 * Make a map's key set match `value` exactly. Retained pairs are reconciled in place, so their key
 * order and the comments attached to their keys survive; keys new to `value` are appended in
 * `value` order, keeping a save's diff down to the lines that actually changed.
 */
function reconcileMap(
  ctx: ReconcileContext,
  map: YAMLMap<unknown, unknown>,
  value: Record<string, unknown>,
): void {
  // An explicitly-undefined key is NOT a key: `Object.keys` reports it but `JSON.stringify` and
  // `yaml.stringify` omit it, so without this filter a key present on disk and set to `undefined`
  // in the payload is rewritten as `key: null` here while the create path drops it. Same rule on
  // both paths, so "the key set matches the payload" holds exactly rather than approximately.
  const wanted = new Set(Object.keys(value).filter((key) => value[key] !== undefined))
  const seen = new Set<string>()

  const retained: Pair<unknown, unknown>[] = []
  for (const pair of map.items) {
    const key = recordKeyOf(pair.key)
    // Drop complex keys (no record counterpart), keys the caller removed, and any duplicate
    // (malformed YAML can carry two pairs with the same key; a record holds one).
    if (key === undefined || !wanted.has(key) || seen.has(key)) continue
    seen.add(key)
    pair.value = reconcileNode(ctx, pair.value, value[key])
    retained.push(pair)
  }
  map.items = retained

  for (const key of Object.keys(value)) {
    if (seen.has(key) || !wanted.has(key)) continue
    map.set(ctx.doc.createNode(key), ctx.doc.createNode(value[key]))
  }
}

/**
 * Make a sequence's items match `value` exactly, aligning by VALUE first and position second.
 *
 * A list has no item identity, so any alignment is a guess and the failure modes are not equally
 * bad: losing a comment shows up in review as a deletion, silently MOVING one onto content it does
 * not describe does not, and the comments this protects are the load-bearing kind ("do not delete
 * this block"). The rules run from most evidence to least, and stop rather than guessing:
 *
 * 1. **Exact value match** — reuse that old node whole, comments and all. This carries a comment
 *    through a pure reorder instead of stranding it on whatever moved into its index.
 * 2. **Same index, still unclaimed, and recognisably the same item** (`looksLikeSameItem`) —
 *    reconcile against it: the edit-in-place case. Same-index rather than "next unclaimed old
 *    node in order", which pairs a newly-inserted item with an unrelated deleted one whenever one
 *    save both removes and adds; and evidence as well as position, because a wholesale
 *    replacement lands on the index it replaced.
 * 3. **Otherwise a fresh node, with no comments.**
 */
function reconcileSeq(
  ctx: ReconcileContext,
  seq: YAMLSeq<unknown>,
  value: readonly unknown[],
): void {
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
    // `consumed` holds OLD indices claimed by rule 1, so this asks "is the node at my index still
    // unclaimed?". Each iteration owns a distinct index, so a candidate cannot be taken twice.
    const candidate = index < oldItems.length && !consumed.has(index) ? oldItems[index] : undefined
    const sameItem =
      candidate !== undefined && looksLikeSameItem(candidate, item) ? candidate : undefined
    return reconcileNode(ctx, sameItem, item)
  })
}

/**
 * Re-serialise `data` onto the YAML text `raw`, or undefined when `raw` does not parse or the
 * reconciled document cannot be printed so that it reads back as its own data.
 *
 * The reconciler decides WHAT changes; {@link spliceSource} then writes those changes into the
 * source text, so untouched lines keep the author's own folding and spacing. When it cannot
 * vouch for a splice, the result is the reconciled document's own `toString()`, which is itself
 * kept only if it parses back to the same data: a carried style that `yaml` prints lossily is
 * dropped and the document re-printed, and failing that the caller writes a plain stringify.
 * The worst case is a re-folded file, or one without its comments; never different data.
 * `rootAtColumnZero` refuses a splice whose first line is indented, for frontmatter, whose
 * framing trims the first line's indentation.
 */
function reconcileYamlSource(
  raw: string,
  data: Record<string, unknown>,
  rootAtColumnZero = false,
): string | undefined {
  const doc: Document = parseDocument(raw)
  if (doc.errors.length > 0) return undefined
  const snapshot = snapshotDocument(doc)
  const ctx: ReconcileContext = { doc, replaced: new WeakMap(), restyled: [] }
  doc.contents = reconcileNode(ctx, doc.contents, data) as Document['contents']
  let reconciled = withSourceLineEndings(doc.toString(), raw)
  if (!readsBackAs(reconciled, doc)) {
    for (const scalar of ctx.restyled) scalar.type = undefined
    reconciled = withSourceLineEndings(doc.toString(), raw)
    if (!readsBackAs(reconciled, doc)) return undefined
  }

  try {
    const spliced = spliceSource(raw, doc, snapshot, ctx.replaced, reconciled)
    if (spliced !== undefined && !(rootAtColumnZero && /^\s*[ \t]\S/.test(spliced))) {
      return spliced
    }
    log.debug('content-serialize', 'source splice not used; writing as yaml prints it')
  } catch (err: unknown) {
    log.debug('content-serialize', 'source splice failed; writing as yaml prints it', {
      error: getErrorMessage(err),
    })
  }
  return reconciled
}

function readsBackAs(text: string, doc: Document): boolean {
  const reparsed = parseDocument(text)
  return reparsed.errors.length === 0 && isDeepStrictEqual(reparsed.toJS(), doc.toJS())
}

/**
 * Serialise entry data as a YAML file, carrying the comments of `existingRaw` through.
 *
 * Falls back to a plain stringify — byte-identical to serialising without preservation — when
 * there is nothing to preserve (a new file) or nothing trustworthy to preserve (the bytes on disk
 * do not parse, or the reconciled document does not read back as its own data). A save must not
 * fail because the previous content was malformed.
 */
export function serializeYaml(data: Record<string, unknown>, existingRaw?: string): string {
  if (existingRaw === undefined) return yamlStringify(data)
  return reconcileYamlSource(existingRaw, data) ?? yamlStringify(data)
}

/**
 * Split a file into its raw frontmatter string, or undefined when there is nothing usable. Two
 * gray-matter hazards:
 *
 * 1. **The options argument is load-bearing.** `matter(str)` with no options reads and writes a
 *    process-global content-keyed cache whose HIT returns an object that has lost `.matter`, so
 *    the second save of the same file silently sees no frontmatter and drops every comment.
 *    Passing an options object skips the cache on both sides (the `if (!options)` guard in
 *    gray-matter's index.js), which also keeps this write path from polluting that cache for
 *    everyone else.
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

/** The body of a file as gray-matter splits it, or undefined when it cannot split it. */
function extractBody(raw: string): string | undefined {
  try {
    return matter(raw, {}).content
  } catch {
    return undefined
  }
}

/** Whether `matter.stringify` writes a frontmatter block for `data` (it skips an empty one). */
function writesFrontmatter(data: Record<string, unknown>): boolean {
  return Object.values(data).some((value) => value !== undefined)
}

/**
 * The body to write: `body`'s content in `existingRaw`'s text wherever they agree
 * (`preserveMarkdownSource`), opening with the blank line the frontmatter is followed by on disk.
 * gray-matter leaves that blank line in the body, and the editor's body does not carry it, so it
 * is restored here even when the splice falls back. A file that had no frontmatter or no body yet
 * gets one blank line, the common markdown formatters' style.
 *
 * With no frontmatter written, the body opens the file: it loses its leading blank lines, except
 * the one newline that stops a body starting with `---` (after any BOM, which gray-matter skips)
 * reading back as frontmatter.
 */
function bodyToWrite(
  body: string,
  data: Record<string, unknown>,
  format: MarkdownBodyFormat,
  existingRaw: string | undefined,
): string {
  const priorBody = existingRaw === undefined ? undefined : extractBody(existingRaw)
  const spliced = priorBody === undefined ? body : preserveMarkdownSource(priorBody, body, format)
  if (!writesFrontmatter(data)) {
    const flush = spliced.replace(/^(?:\r?\n)+/, '')
    return /^\uFEFF?---/.test(flush) ? `\n${flush}` : flush
  }
  if (/^\r?\n/.test(spliced) || !/\S/.test(spliced)) return spliced

  const priorKeptBody =
    priorBody !== undefined &&
    /\S/.test(priorBody) &&
    existingRaw !== undefined &&
    extractRawFrontmatter(existingRaw) !== undefined
  const lead = priorKeptBody ? (/^(?:\r?\n)*/.exec(priorBody)?.[0] ?? '') : '\n'
  return lead + spliced
}

/**
 * Serialise an md/mdx entry, carrying the comments of `existingRaw`'s frontmatter and the source
 * text of its unchanged body blocks through. The reconciled YAML goes back through
 * `matter.stringify` via a custom stringify engine rather than being spliced between
 * hand-written `---` lines, so delimiters and the trailing newline stay exactly what gray-matter
 * would have produced.
 */
export function serializeFrontmatter(
  editorBody: string,
  data: Record<string, unknown>,
  existingRaw: string | undefined,
  format: MarkdownBodyFormat,
): string {
  // An object, never the body string: `matter.stringify` re-parses a string as a whole file, so a
  // body starting with `---` would be read as frontmatter and dropped.
  const file = { content: bodyToWrite(editorBody, data, format, existingRaw) }
  if (existingRaw === undefined) return matter.stringify(file, data)

  const existingFrontmatter = extractRawFrontmatter(existingRaw)
  if (existingFrontmatter === undefined) return matter.stringify(file, data)

  const reconciled = reconcileYamlSource(existingFrontmatter, data, true)
  if (reconciled === undefined) return matter.stringify(file, data)

  return matter.stringify(file, data, {
    engines: {
      yaml: {
        parse: () => ({}),
        stringify: () => reconciled,
      },
    },
  })
}
