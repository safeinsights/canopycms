/**
 * Print a reconciled YAML document by editing the source text it was parsed from, so every byte
 * the reconciler did not change stays exactly as the author wrote it.
 *
 * `Document.toString()` re-emits every scalar from its VALUE: folded and long plain scalars are
 * re-wrapped at the library's line width, so the first CMS save of a hand-written file rewrites
 * lines nobody edited. Here a clean subtree is copied verbatim from the source, and only a slot
 * the reconciler touched is re-rendered, at the column it already occupies:
 *
 * - **Map**: the reconciler keeps retained pairs in source order and appends new ones, so a map
 *   becomes a list of local edits — delete a dropped pair's lines, re-render a pair whose value
 *   was replaced, recurse into a value edited in place, insert new pairs after the last item.
 * - **Sequence**: items can be reordered, so the item region is rebuilt as a concatenation of
 *   per-item chunks, each one either an original item's source (recursively patched) or a freshly
 *   rendered item.
 *
 * A chunk is an item's lines plus the comment and blank lines above it, which is where `yaml`
 * attaches those comments (the item's `commentBefore`), so a chunk moves and dies with exactly
 * the comments the reconciler moves and drops. Above the FIRST item they belong to the
 * collection instead, and stay put.
 *
 * Anything this does not handle returns `undefined` from that collection, and the parent
 * re-renders the whole slot instead; only at the root does that reach the caller, which falls
 * back to `toString()`. Every splice is also re-parsed and checked against the reconciled
 * document ({@link printsAs}) before it is returned, so a wrong splice costs formatting, never
 * data.
 */

import { isDeepStrictEqual } from 'node:util'

import {
  Document,
  parseDocument,
  isAlias,
  isCollection,
  isMap,
  isNode,
  isPair,
  isScalar,
  isSeq,
  YAMLMap,
  visit,
  YAMLSeq,
  type Pair,
} from 'yaml'

/** Successor markers: the end of a collection, and an item with no source counterpart. */
const END = Symbol('end')
const FRESH = Symbol('fresh')

/** `yaml`'s default `lineWidth`, which `Document.toString()` folds at. */
const LINE_WIDTH = 80

/** Narrowest fold width a deeply indented fragment is rendered at. */
const MIN_LINE_WIDTH = 40

type Collection = YAMLMap<unknown, unknown> | YAMLSeq<unknown>

/** One parsed item: a pair for a map, the item node for a sequence. */
interface SnapshotItem {
  readonly item: unknown
  /** A map pair's value as parsed; the reconciler reassigns `pair.value`. */
  readonly value: unknown
}

/** The parsed document's shape, taken before the reconciler runs. */
export interface SourceSnapshot {
  /** Every collection's items exactly as parsed. */
  readonly items: ReadonlyMap<Collection, readonly SnapshotItem[]>
  /** The source uses anchors or aliases; an edit through an alias is not local to one slot. */
  readonly anchored: boolean
}

export function snapshotDocument(doc: Document): SourceSnapshot {
  const items = new Map<Collection, SnapshotItem[]>()
  const visitNode = (node: unknown): void => {
    if (isMap(node)) {
      items.set(
        node,
        node.items.map((pair) => ({ item: pair, value: pair.value })),
      )
      for (const pair of node.items) visitNode(pair.value)
    } else if (isSeq(node)) {
      items.set(
        node,
        node.items.map((item) => ({ item, value: item })),
      )
      for (const item of node.items) visitNode(item)
    }
  }
  visitNode(doc.contents)
  let anchored = false
  visit(doc, (_key, node) => {
    if (isAlias(node) || (isNode(node) && node.anchor !== undefined)) {
      anchored = true
      return visit.BREAK
    }
    return undefined
  })
  return { items, anchored }
}

interface LeadingComment {
  commentBefore?: string | null
  spaceBefore?: boolean
}

interface Edit {
  readonly start: number
  readonly end: number
  readonly text: string
}

/** Where one item sits in the source. */
interface ItemGeometry {
  /** Offset of the item's first token: the key, or the `-` indicator. */
  readonly content: number
  /** The item shares its first line with the parent's `- ` (a compact `- key: value`). */
  readonly inline: boolean
  /** Start of the item's first line, or `content` itself for an inline item. */
  readonly lineStart: number
  /** Just past the line ending of the item's last non-blank line. */
  readonly end: number
}

class SourceSplicer {
  private readonly dirtyMemo = new Map<unknown, boolean>()

  constructor(
    private readonly raw: string,
    private readonly eol: string,
    private readonly doc: Document,
    private readonly snapshot: SourceSnapshot,
    private readonly replaced: WeakMap<object, unknown>,
  ) {}

  print(): string | undefined {
    const root = this.doc.contents
    if (!isCollection(root) || !this.snapshot.items.has(root)) return undefined
    if (!this.isDirty(root)) return this.raw
    if (this.snapshot.anchored) return undefined
    const edits = this.collectionEdits(root)
    return edits === undefined ? undefined : this.applyEdits(0, this.raw.length, edits)
  }

  /**
   * Did the reconciler change anything under this node? An original scalar is never mutated in
   * place (a changed value gets a fresh node), so only collections can be dirty.
   */
  private isDirty(node: unknown): boolean {
    if (!isCollection(node)) return false
    const memo = this.dirtyMemo.get(node)
    if (memo !== undefined) return memo
    const snap = this.snapshot.items.get(node)
    let dirty = snap === undefined || snap.length !== node.items.length
    for (let i = 0; !dirty && snap !== undefined && i < snap.length; i++) {
      const now: unknown = node.items[i]
      const before = snap[i]
      if (now !== before.item) dirty = true
      else if (isPair(now)) dirty = now.value !== before.value || this.isDirty(now.value)
      else dirty = this.isDirty(now)
    }
    this.dirtyMemo.set(node, dirty)
    return dirty
  }

  private collectionEdits(node: Collection): Edit[] | undefined {
    if (node.flow) return undefined
    const snap = this.snapshot.items.get(node)
    // An emptied block collection has no block spelling (`key:` alone reads back as null).
    if (snap === undefined || snap.length === 0 || node.items.length === 0) return undefined
    const geometry: ItemGeometry[] = []
    for (const { item, value } of snap) {
      const g = isPair(item) ? this.pairGeometry(item, value) : this.seqItemGeometry(item)
      if (g === undefined) return undefined
      geometry.push(g)
    }
    if (!this.isBlockLayout(geometry)) return undefined
    return isMap(node) ? this.mapEdits(node, snap, geometry) : this.seqEdits(node, snap, geometry)
  }

  private mapEdits(
    map: YAMLMap<unknown, unknown>,
    snap: readonly SnapshotItem[],
    geometry: readonly ItemGeometry[],
  ): Edit[] | undefined {
    const col = this.column(geometry[0].content)
    const original = new Set(snap.map((s) => s.item))
    const kept = new Set<unknown>(map.items)
    const edits: Edit[] = []

    // Retained pairs must still be in source order, followed only by new pairs.
    const retainedOrder = map.items.filter((pair) => original.has(pair))
    const expectedOrder = snap.map((s) => s.item).filter((pair) => kept.has(pair))
    if (retainedOrder.some((pair, i) => pair !== expectedOrder[i])) return undefined
    const added = map.items.slice(retainedOrder.length)
    if (added.some((pair) => original.has(pair))) return undefined

    const layout = [...geometry]
    for (let i = 0; i < snap.length; i++) {
      const { item, value: before } = snap[i]
      const g = layout[i]
      if (!isPair(item)) return undefined
      if (!kept.has(item)) {
        if (g.inline) {
          const next = this.promoteToInline(snap, layout, kept)
          if (next === undefined) return undefined
          edits.push({ start: g.content, end: layout[next].content, text: '' })
          i = next - 1
        } else {
          const start =
            i === 0 ? this.ownLeadingLines(map, item, g.lineStart) : this.chunkStart(layout, i)
          edits.push({ start, end: g.end, text: '' })
        }
        continue
      }
      const now = item.value
      const clean = now === before && !this.isDirty(now)
      const inner = clean
        ? []
        : now === before && isCollection(now)
          ? this.collectionEdits(now)
          : undefined
      if (inner !== undefined) {
        const next = map.items[map.items.indexOf(item) + 1] ?? END
        if ((i + 1 < snap.length ? snap[i + 1].item : END) !== next) {
          edits.push(...this.outdentedCommentEdits(g, col))
        }
        edits.push(...inner)
        continue
      }
      // The key is never replaced, so the comment lines above it stay in the source.
      const text = withoutLeadingComment(item.key, () => this.render(mapOf([item]), col, g.inline))
      edits.push({ start: g.lineStart, end: g.end, text: this.matchFinalNewline(g.end, text) })
    }

    if (added.length > 0) {
      const at = layout[layout.length - 1].end
      const text = this.render(mapOf(added), col, false)
      edits.push({ start: at, end: at, text: this.raw[at - 1] === '\n' ? text : this.eol + text })
    }
    return edits
  }

  private seqEdits(
    seq: YAMLSeq<unknown>,
    snap: readonly SnapshotItem[],
    geometry: readonly ItemGeometry[],
  ): Edit[] | undefined {
    if (geometry[0].inline) return undefined
    const col = this.column(geometry[0].content)
    const oldIndex = new Map<unknown, number>(snap.map((s, i) => [s.item, i]))
    const parts: string[] = []

    const sourceOf = (item: unknown): unknown =>
      oldIndex.has(item) ? item : isNode(item) ? this.replaced.get(item) : undefined
    for (const [k, item] of seq.items.entries()) {
      const j = oldIndex.get(item)
      let part: string
      if (j !== undefined) {
        const start = this.chunkStart(geometry, j)
        const inner = isCollection(item) && this.isDirty(item) ? this.collectionEdits(item) : []
        const next = k + 1 < seq.items.length ? sourceOf(seq.items[k + 1]) : END
        const moved = (j + 1 < snap.length ? snap[j + 1].item : END) !== (next ?? FRESH)
        part =
          inner !== undefined
            ? this.applyEdits(start, geometry[j].end, [
                ...inner,
                ...(moved ? this.outdentedCommentEdits(geometry[j], col) : []),
              ])
            : this.raw.slice(start, geometry[j].lineStart) +
              withoutLeadingComment(item, () => this.render(seqOf(item), col, false))
      } else {
        // A fresh node keeps the comment lines above its slot only if the reconciler carried
        // them across; it does not off a replaced collection.
        const old = isNode(item) ? this.replaced.get(item) : undefined
        const k = old === undefined ? undefined : oldIndex.get(old)
        part =
          k !== undefined && sameLeadingComment(old, item)
            ? this.raw.slice(this.chunkStart(geometry, k), geometry[k].lineStart) +
              withoutLeadingComment(item, () => this.render(seqOf(item), col, false))
            : this.render(seqOf(item), col, false)
      }
      parts.push(part.endsWith('\n') ? part : part + this.eol)
    }

    const start = geometry[0].lineStart
    const end = geometry[geometry.length - 1].end
    return [{ start, end, text: this.matchFinalNewline(end, parts.join('')) }]
  }

  /** Rendered text always ends in a line break; drop it where the source it replaces had none. */
  private matchFinalNewline(end: number, text: string): string {
    return this.raw[end - 1] !== '\n' && text.endsWith(this.eol)
      ? text.slice(0, -this.eol.length)
      : text
  }

  /**
   * The first pair shares the parent's `- ` line and was dropped: move the first retained pair up
   * onto that line, so the pairs before it go and the rest of the map stays as written. Returns
   * that pair's index, or undefined when no pair is retained or comment lines above it would have
   * to go with the lines being removed.
   */
  private promoteToInline(
    snap: readonly SnapshotItem[],
    layout: ItemGeometry[],
    kept: ReadonlySet<unknown>,
  ): number | undefined {
    const next = snap.findIndex((s) => kept.has(s.item))
    if (next <= 0) return undefined
    if (this.raw.slice(this.chunkStart(layout, next), layout[next].lineStart).includes('#')) {
      return undefined
    }
    const g = layout[next]
    layout[next] = { ...g, inline: true, lineStart: g.content }
    return next
  }

  /**
   * Where a dropped FIRST pair's lines begin. The comment lines above a nested collection's first
   * item are the collection's and stay, but above the root map's first key `yaml` gives them to
   * the key, so the reconciler drops them with it and so must the splice.
   */
  private ownLeadingLines(
    map: YAMLMap<unknown, unknown>,
    pair: Pair<unknown, unknown>,
    start: number,
  ): number {
    const key = pair.key as LeadingComment
    if (map !== this.doc.contents || !key.commentBefore || this.doc.commentBefore) return start
    let at = start
    while (at > 0) {
      const previous = this.lineStart(at - 1)
      if (previous >= at) break
      if (!/^[ \t]*(#.*)?\r?\n?$/.test(this.raw.slice(previous, at))) break
      at = previous
    }
    return at
  }

  /**
   * A comment line inside an item at or left of the item's own column, which `yaml` reads as the
   * item's because it follows a deeper line, reads to a person as being about whatever comes next.
   * Once the item's neighbour below changes, indent such lines to the deeper line above them —
   * where `toString()` draws them — so they do not head content they were never about.
   */
  private outdentedCommentEdits(g: ItemGeometry, col: number): Edit[] {
    const edits: Edit[] = []
    let deeper: number | undefined
    let at = this.raw.indexOf('\n', g.content) + 1
    while (at > 0 && at < g.end) {
      const lineEnd = this.raw.indexOf('\n', at)
      const line = this.raw.slice(at, lineEnd === -1 ? g.end : lineEnd)
      const indent = line.length - line.trimStart().length
      if (line.trim() !== '') {
        if (indent > col) deeper = indent
        else if (line.trimStart().startsWith('#') && deeper !== undefined) {
          edits.push({ start: at, end: at + indent, text: ' '.repeat(deeper) })
        }
      }
      at = lineEnd === -1 ? g.end : lineEnd + 1
    }
    return edits
  }

  /** Where item `i`'s chunk begins: its own line for the first item, else the previous item's end. */
  private chunkStart(geometry: readonly ItemGeometry[], i: number): number {
    return i === 0 ? geometry[0].lineStart : geometry[i - 1].end
  }

  /**
   * Every item starts at the same column, in order, and only the first may share its line with
   * the parent's `- ` (a compact `- key: value`). Anything else — an explicit `? key`, a
   * multi-line key, a node property on its own line — is not a layout this splices.
   */
  private isBlockLayout(geometry: readonly ItemGeometry[]): boolean {
    const col = this.column(geometry[0].content)
    let previousEnd = -1
    for (const [i, g] of geometry.entries()) {
      if (this.column(g.content) !== col) return false
      if (i > 0 && g.inline) return false
      if (g.lineStart < previousEnd || g.end <= g.content) return false
      previousEnd = g.end
    }
    return true
  }

  /** `value` is the pair's value as parsed: the reconciler may already have replaced it. */
  private pairGeometry(pair: Pair<unknown, unknown>, value: unknown): ItemGeometry | undefined {
    const key = pair.key
    if (!isScalar(key) || key.range == null) return undefined
    const content = key.range[0]
    const range = isNode(value) && value.range != null ? value.range : key.range
    return this.geometry(content, range[1], range[2])
  }

  private seqItemGeometry(item: unknown): ItemGeometry | undefined {
    if (!isNode(item) || item.range == null) return undefined
    let dash = item.range[0] - 1
    while (dash >= 0 && ' \t\r\n'.includes(this.raw[dash])) dash--
    if (dash < 0 || this.raw[dash] !== '-') return undefined
    return this.geometry(dash, item.range[1], item.range[2])
  }

  /**
   * Trailing blank lines are not the item's — `yaml` gives them to whatever follows — unless they
   * are inside the value itself, as a keep-chomped (`|+`) block scalar's are. A node that ends in
   * a comment can end inside the NEXT line's indentation; that line is not the item's either.
   */
  private geometry(content: number, valueEnd: number, nodeEnd: number): ItemGeometry {
    const nodeEndLine = this.lineStart(nodeEnd)
    if (nodeEndLine > content && /^[ \t]*$/.test(this.raw.slice(nodeEndLine, nodeEnd))) {
      nodeEnd = nodeEndLine
      valueEnd = Math.min(valueEnd, nodeEnd)
    }
    let last = Math.max(content, nodeEnd - 1)
    while (last > content && last >= valueEnd && ' \t\r\n'.includes(this.raw[last])) last--
    const newline = this.raw.indexOf('\n', last)
    const lineStart = this.lineStart(content)
    const onOwnLine = /^ *$/.test(this.raw.slice(lineStart, content))
    return {
      content,
      inline: !onOwnLine,
      lineStart: onOwnLine ? lineStart : content,
      end: newline === -1 ? this.raw.length : newline + 1,
    }
  }

  private lineStart(offset: number): number {
    // `lastIndexOf` clamps a negative index to 0, which would find a newline AT offset 0.
    return offset <= 0 ? 0 : this.raw.lastIndexOf('\n', offset - 1) + 1
  }

  private column(offset: number): number {
    return offset - this.lineStart(offset)
  }

  private applyEdits(start: number, end: number, edits: readonly Edit[]): string {
    const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end)
    let out = ''
    let cursor = start
    for (const edit of sorted) {
      if (edit.start < cursor || edit.end > end) throw new Error('overlapping source edits')
      out += this.raw.slice(cursor, edit.start) + edit.text
      cursor = edit.end
    }
    return out + this.raw.slice(cursor, end)
  }

  /**
   * Render `items` as a block collection whose items sit at column `col`. `inline` leaves the
   * first line unindented, for a slot that continues the parent's `- ` line. The fold width is
   * reduced by the indent so the lines come out as wide as `toString()` would make them there.
   */
  private render(container: Collection, col: number, inline: boolean): string {
    const fragment = new Document()
    fragment.schema = this.doc.schema
    fragment.contents = container
    // A comment parsed from a CRLF file keeps a `\r` on every line but its last; the line ending
    // is this.eol's to write.
    const text = fragment
      .toString({ lineWidth: Math.max(MIN_LINE_WIDTH, LINE_WIDTH - col) })
      .replace(/\r\n?/g, '\n')
    const indent = ' '.repeat(col)
    const lines = text.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    return lines
      .map((line, i) => (line === '' || (i === 0 && inline) ? line : indent + line))
      .map((line) => line + this.eol)
      .join('')
  }
}

function mapOf(pairs: readonly Pair<unknown, unknown>[]): YAMLMap<unknown, unknown> {
  const map = new YAMLMap<unknown, unknown>()
  map.items = [...pairs]
  return map
}

function seqOf(item: unknown): YAMLSeq<unknown> {
  const seq = new YAMLSeq<unknown>()
  seq.items = [item]
  return seq
}

function sameLeadingComment(a: unknown, b: unknown): boolean {
  if (!isNode(a) || !isNode(b)) return false
  const x = a as LeadingComment
  const y = b as LeadingComment
  return (
    (x.commentBefore ?? undefined) === (y.commentBefore ?? undefined) &&
    !!x.spaceBefore === !!y.spaceBefore
  )
}

/** Run `fn` with `node`'s leading comment and blank line hidden, because the source keeps them. */
function withoutLeadingComment<T>(node: unknown, fn: () => T): T {
  if (!isNode(node)) return fn()
  const target = node as LeadingComment
  const { commentBefore, spaceBefore } = target
  target.commentBefore = undefined
  target.spaceBefore = false
  try {
    return fn()
  } finally {
    target.commentBefore = commentBefore
    target.spaceBefore = spaceBefore
  }
}

/**
 * The line ending a splice must write, or undefined for a file mixing them (or using bare `\r`),
 * which no single choice would reproduce.
 */
function lineEndingOf(raw: string): string | undefined {
  const crlf = (raw.match(/\r\n/g) ?? []).length
  const lf = (raw.match(/\n/g) ?? []).length
  const cr = (raw.match(/\r/g) ?? []).length
  if (crlf === 0) return cr === 0 ? '\n' : undefined
  return crlf === lf && crlf === cr ? '\r\n' : undefined
}

/**
 * `printed` (a `toString()`) written with `raw`'s line endings: CRLF when `raw` is consistently
 * CRLF, else LF. Either way without the stray `\r` that comments parsed from CRLF keep, so a
 * whole-file re-print does not leave the file with mixed line endings.
 */
export function withSourceLineEndings(printed: string, raw: string): string {
  const text = printed.replace(/\r\n?/g, '\n')
  return lineEndingOf(raw) === '\r\n' ? text.replace(/\n/g, '\r\n') : text
}

/**
 * The source text of `raw` with only the reconciler's changes applied, or undefined when the
 * document holds a construct this does not splice or the splice fails its self-check.
 * `replaced` maps each node the reconciler created for an existing slot back to the node it
 * replaced; `printed` is the reconciled document's `toString()`.
 */
export function spliceSource(
  raw: string,
  doc: Document,
  snapshot: SourceSnapshot,
  replaced: WeakMap<object, unknown>,
  printed: string,
): string | undefined {
  const eol = lineEndingOf(raw)
  if (eol === undefined) return undefined
  const spliced = new SourceSplicer(raw, eol, doc, snapshot, replaced).print()
  return spliced !== undefined && printsAs(spliced, doc, printed) ? spliced : undefined
}

/**
 * Does `candidate` read back as the text it replaces, `printed`, would? It must parse cleanly,
 * hold the reconciled document's data, and print as `printed` re-parsed prints — the same keys
 * in the same order, the same comments on the same nodes.
 *
 * Re-parsed, not `printed` itself: where `yaml` cannot write the reconciled document so that it
 * reads back as itself — a comment following an outdented trailing comment is read as the
 * previous item's, whoever it belonged to — the splice need only be no worse than `printed`.
 * Wherever it can, the two are the same comparison.
 *
 * Blank lines and trailing whitespace are left out: they are formatting the splice copies from
 * the source, and `yaml` prints them inconsistently (a blank line inside an indented block as the
 * indent alone; a blank line before a list's first item doubled; a stray `\r` kept in some
 * comments parsed from a CRLF file).
 */
function printsAs(candidate: string, reconciled: Document, printed: string): boolean {
  if (candidate === printed) return true
  const reparsed = parseDocument(candidate)
  if (reparsed.errors.length > 0) return false
  if (!isDeepStrictEqual(reparsed.toJS(), reconciled.toJS())) return false
  return layoutFree(reparsed.toString()) === layoutFree(parseDocument(printed).toString())
}

function layoutFree(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t\r]+$/, ''))
    .filter((line) => line !== '')
    .join('\n')
}
