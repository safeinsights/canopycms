/**
 * Source-preserving save for md/mdx bodies.
 *
 * The editor sends a body re-serialised from its own document model, so every block comes back
 * in the serialiser's style (bullet and emphasis markers, rule style, escapes, no blank line
 * after the frontmatter) whether or not the user touched it. This writes the on-disk text of
 * every block whose MEANING the edit left alone, and the editor's text only where it changed:
 *
 * - Top-level blocks are aligned by a position-free canonical form of their mdast, so a block
 *   matches only when it parses to the same tree. A matched block is written from disk.
 * - A changed block paired with an original of the same kind is spliced one level down when it
 *   is a list (by item) or a list item (by child block), so editing one item leaves its siblings
 *   alone. New items take the original list's marker and numbering.
 * - Whitespace between two blocks that were adjacent on disk is the disk's; around new text it is
 *   the editor's, re-indented into the original's nesting.
 *
 * The result is kept only if it parses to exactly the tree the editor's body parses to. A splice
 * that fails that check is retried without descending into lists, and failing that the editor's
 * body is written as sent, so the worst case is today's re-serialised body, never different
 * content.
 */

import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mdxFromMarkdown } from 'mdast-util-mdx'
import { gfm } from 'micromark-extension-gfm'
import { mdxjs } from 'micromark-extension-mdxjs'

import { createDebugLogger } from './debug'
import { getErrorMessage } from './error'
import { withSourceLineEndings } from './yaml-source-splice'

const log = createDebugLogger({ prefix: 'MarkdownBodySplice' })

export type MarkdownBodyFormat = 'md' | 'mdx'

/** The parts of an mdast node this module reads. */
interface MdNode {
  readonly type: string
  readonly children?: readonly MdNode[]
  readonly position?: {
    readonly start: { readonly offset?: number }
    readonly end: { readonly offset?: number }
  }
  readonly ordered?: boolean | null
  readonly checked?: boolean | null
}

/** One side's source text, and the indentation its continuation lines carry at this depth. */
interface Side {
  readonly text: string
  readonly indent: string
}

/** One block of the output, in the editor's order. `orig` is the on-disk block it stands for. */
interface Piece {
  text: string
  readonly orig: number | undefined
}

/** Above this many LCS cells the middle of a sequence is treated as one changed run. */
const MAX_LCS_CELLS = 4_000_000

function parse(text: string, format: MarkdownBodyFormat): MdNode | undefined {
  try {
    return format === 'mdx'
      ? fromMarkdown(text, {
          extensions: [gfm(), mdxjs()],
          mdastExtensions: [gfmFromMarkdown(), mdxFromMarkdown()],
        })
      : fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  } catch (err: unknown) {
    log.debug('markdown-body-splice', 'body does not parse', { error: getErrorMessage(err) })
    return undefined
  }
}

/**
 * A node's meaning as a string: its tree without source positions. `data` goes too, because
 * the parser fills it only with derived information (an MDX expression's estree, which carries
 * its own offsets) and never with content. Line endings inside values are normalised, so a CRLF
 * file's blocks match the editor's LF ones.
 */
function canonical(node: MdNode): string {
  return JSON.stringify(node, (key, value: unknown) => {
    if (key === 'position' || key === 'data') return undefined
    return typeof value === 'string' ? value.replace(/\r\n?/g, '\n') : value
  })
}

/** What a changed block must share with an original to be paired with it. */
function kindOf(node: MdNode): string {
  return `${node.type}:${String(node.ordered ?? '')}:${String(node.checked ?? '')}`
}

function startOf(node: MdNode | undefined): number | undefined {
  return node?.position?.start.offset
}

function endOf(node: MdNode | undefined): number | undefined {
  return node?.position?.end.offset
}

function sliceOf(text: string, node: MdNode): string | undefined {
  const start = startOf(node)
  const end = endOf(node)
  return start === undefined || end === undefined ? undefined : text.slice(start, end)
}

/**
 * Move continuation lines from one nesting to another: a line starting with `from` gets `to`
 * instead. The first line is never touched (it continues whatever precedes it), and neither is
 * an empty line, which would otherwise gain trailing spaces.
 */
function reindent(text: string, from: string, to: string): string {
  if (from === to) return text
  return text
    .split('\n')
    .map((line, i) =>
      i > 0 && line !== '' && line.startsWith(from) ? to + line.slice(from.length) : line,
    )
    .join('\n')
}

/**
 * Index pairs of a longest common subsequence of `a` and `b`, in order. Common prefix and suffix
 * are matched first, which is the whole answer for the usual one-region edit.
 */
function matchSequences(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = []
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) {
    pairs.push([head, head])
    head++
  }
  let endA = a.length
  let endB = b.length
  while (endA > head && endB > head && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }

  const n = endA - head
  const m = endB - head
  if (n > 0 && m > 0 && n * m <= MAX_LCS_CELLS) {
    const width = m + 1
    // lengths[i * width + j]: LCS length of a[head + i, endA) and b[head + j, endB).
    const lengths = new Uint32Array((n + 1) * width)
    const at = (i: number, j: number): number => lengths[i * width + j] ?? 0
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lengths[i * width + j] =
          a[head + i] === b[head + j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (a[head + i] === b[head + j]) {
        pairs.push([head + i, head + j])
        i++
        j++
      } else if (at(i + 1, j) >= at(i, j + 1)) {
        i++
      } else {
        j++
      }
    }
  }

  for (let k = 0; k < a.length - endA; k++) pairs.push([endA + k, endB + k])
  return pairs
}

/**
 * The text a line has before `offset`, provided it is pure indentation plus list markers: the
 * width continuation lines of a block starting at `offset` are indented by. Undefined for a tab
 * or any other character, whose width this module does not reason about.
 */
function leadWidth(text: string, offset: number): number | undefined {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1
  const lead = text.slice(lineStart, offset)
  return /^(?: |[-*+](?= )|\d{1,9}[.)](?= )|\[[ xX]\](?= ))*$/.test(lead) ? lead.length : undefined
}

class Splicer {
  constructor(
    private readonly original: string,
    private readonly updated: string,
    /** Whether a changed list or list item may be spliced by its children. */
    private readonly deep: boolean,
  ) {}

  /** The whole body, or undefined when either side has nothing to align. */
  body(before: MdNode, after: MdNode): string | undefined {
    const oNodes = before.children ?? []
    const nNodes = after.children ?? []
    const first = startOf(oNodes[0])
    const last = endOf(oNodes[oNodes.length - 1])
    if (first === undefined || last === undefined || nNodes.length === 0) return undefined
    const o: Side = { text: this.original, indent: '' }
    const n: Side = { text: this.updated, indent: '' }
    const pieces = this.siblings(o, oNodes, n, nNodes)
    if (pieces === undefined) return undefined
    const run = this.join(pieces, o, oNodes, n, nNodes)
    return run === undefined
      ? undefined
      : this.original.slice(0, first) + run + this.original.slice(last)
  }

  /** Output blocks for one sibling sequence, in the editor's order. */
  private siblings(
    o: Side,
    oNodes: readonly MdNode[],
    n: Side,
    nNodes: readonly MdNode[],
  ): Piece[] | undefined {
    const oKeys = oNodes.map(canonical)
    const nKeys = nNodes.map(canonical)
    const pairs = matchSequences(oKeys, nKeys)
    // Originals the alignment left unmatched, by meaning: a block that MOVED is matched by the
    // alignment on one side of its siblings only, and is written from here instead.
    const unmatched = new Map<string, number[]>()
    const matched = new Set(pairs.map(([oi]) => oi))
    oKeys.forEach((key, index) => {
      if (matched.has(index)) return
      const bucket = unmatched.get(key)
      if (bucket) bucket.push(index)
      else unmatched.set(key, [index])
    })

    const pieces: Piece[] = []
    let oNext = 0
    let nNext = 0
    for (const [oi, ni] of [...pairs, [oNodes.length, nNodes.length] as [number, number]]) {
      // The changed run between two matches. Its blocks pair by kind, in order: an in-place
      // edit, possibly beside insertions and deletions. A paired block stands in its original's
      // place for whitespace, and may be spliced by its children.
      const kinds = matchSequences(
        oNodes.slice(oNext, oi).map(kindOf),
        nNodes.slice(nNext, ni).map(kindOf),
      )
      const partner = new Map(kinds.map(([a, b]) => [nNext + b, oNext + a]))
      for (let k = nNext; k < ni; k++) {
        const nNode = nNodes[k]
        if (nNode === undefined) return undefined
        const moved = unmatched.get(nKeys[k] ?? '')?.shift()
        const movedNode = moved === undefined ? undefined : oNodes[moved]
        if (movedNode !== undefined) {
          const text = sliceOf(o.text, movedNode)
          if (text === undefined) return undefined
          pieces.push({ text, orig: moved })
          continue
        }
        const oIndex = partner.get(k)
        const oNode = oIndex === undefined ? undefined : oNodes[oIndex]
        const text =
          (oNode && this.deep ? this.changed(o, oNode, n, nNode) : undefined) ??
          this.fresh(n, nNode, o)
        if (text === undefined) return undefined
        pieces.push({ text, orig: oIndex })
      }
      const oNode = oNodes[oi]
      if (oNode !== undefined && ni < nNodes.length) {
        const text = sliceOf(o.text, oNode)
        if (text === undefined) return undefined
        pieces.push({ text, orig: oi })
      }
      oNext = oi + 1
      nNext = ni + 1
    }
    return pieces
  }

  /** The editor's text for a node, moved into the original's nesting and line endings. */
  private fresh(n: Side, node: MdNode, o: Side): string | undefined {
    const text = sliceOf(n.text, node)
    return text === undefined ? undefined : this.ownEndings(reindent(text, n.indent, o.indent))
  }

  /** Whitespace from the editor's body, moved into the original's nesting and line endings. */
  private editorGap(gap: string | undefined, n: Side, o: Side): string | undefined {
    return gap === undefined ? undefined : this.ownEndings(reindent(gap, n.indent, o.indent))
  }

  private ownEndings(text: string): string {
    return withSourceLineEndings(text, this.original)
  }

  /** A changed node spliced by its children, or undefined to write the editor's text. */
  private changed(o: Side, oNode: MdNode, n: Side, nNode: MdNode): string | undefined {
    if (oNode.type === 'list' && nNode.type === 'list' && oNode.ordered === nNode.ordered) {
      return this.list(o, oNode, n, nNode)
    }
    if (
      oNode.type === 'listItem' &&
      nNode.type === 'listItem' &&
      (oNode.checked ?? null) === (nNode.checked ?? null)
    ) {
      return this.item(o, oNode, n, nNode)
    }
    return undefined
  }

  private list(o: Side, oList: MdNode, n: Side, nList: MdNode): string | undefined {
    const oItems = oList.children ?? []
    const nItems = nList.children ?? []
    const markers = listMarkers(o.text, oItems, Boolean(oList.ordered))
    if (markers === undefined) return undefined
    const pieces = this.siblings(o, oItems, n, nItems)
    if (pieces === undefined) return undefined
    for (const [index, piece] of pieces.entries()) {
      const text = markers(piece.text, index)
      if (text === undefined) return undefined
      piece.text = text
    }
    return this.join(pieces, o, oItems, n, nItems)
  }

  private item(o: Side, oItem: MdNode, n: Side, nItem: MdNode): string | undefined {
    const oChildren = oItem.children ?? []
    const nChildren = nItem.children ?? []
    const oStart = startOf(oItem)
    const oContent = startOf(oChildren[0])
    const nContent = startOf(nChildren[0])
    if (oStart === undefined || oContent === undefined || nContent === undefined) return undefined
    const prefix = o.text.slice(oStart, oContent)
    if (prefix.includes('\n')) return undefined
    const oWidth = leadWidth(o.text, oContent)
    const nWidth = leadWidth(n.text, nContent)
    if (oWidth === undefined || nWidth === undefined) return undefined
    const oInner: Side = { text: o.text, indent: ' '.repeat(oWidth) }
    const nInner: Side = { text: n.text, indent: ' '.repeat(nWidth) }
    const pieces = this.siblings(oInner, oChildren, nInner, nChildren)
    if (pieces === undefined) return undefined
    const run = this.join(pieces, oInner, oChildren, nInner, nChildren)
    return run === undefined ? undefined : prefix + run
  }

  /**
   * Join output blocks. Between two blocks that were adjacent on disk the disk's whitespace is
   * kept; otherwise the editor's (every output block pair is adjacent in the editor's body).
   */
  private join(
    pieces: readonly Piece[],
    o: Side,
    oNodes: readonly MdNode[],
    n: Side,
    nNodes: readonly MdNode[],
  ): string | undefined {
    let out = ''
    for (const [k, piece] of pieces.entries()) {
      if (k > 0) {
        const prev = pieces[k - 1]?.orig
        const gap =
          prev !== undefined && piece.orig === prev + 1
            ? gapBetween(o.text, oNodes[prev], oNodes[piece.orig])
            : this.editorGap(gapBetween(n.text, nNodes[k - 1], nNodes[k]), n, o)
        if (gap === undefined) return undefined
        out += gap
      }
      out += piece.text
    }
    return out
  }
}

function gapBetween(
  text: string,
  a: MdNode | undefined,
  b: MdNode | undefined,
): string | undefined {
  const end = endOf(a)
  const start = startOf(b)
  return end === undefined || start === undefined ? undefined : text.slice(end, start)
}

/**
 * Rewrites an output item's marker to the original list's: its bullet character, or for an
 * ordered list its delimiter and numbering scheme (all one number when the original's first two
 * items share one, else counting up from its start). Undefined when the original's markers
 * cannot be read, or when renumbering would change the width of a multi-line item, whose
 * continuation lines are aligned to the old width.
 */
function listMarkers(
  text: string,
  items: readonly MdNode[],
  ordered: boolean,
): ((itemText: string, index: number) => string | undefined) | undefined {
  const firstStart = startOf(items[0])
  if (firstStart === undefined) return undefined
  if (!ordered) {
    const bullet = text[firstStart]
    if (bullet !== '-' && bullet !== '*' && bullet !== '+') return undefined
    return (itemText) => (/^[-*+]/.test(itemText) ? bullet + itemText.slice(1) : undefined)
  }
  const numberAt = (offset: number | undefined): RegExpExecArray | null =>
    offset === undefined ? null : /^(\d{1,9})([.)])/.exec(text.slice(offset, offset + 10))
  const first = numberAt(firstStart)
  if (first === null) return undefined
  const start = Number(first[1])
  const delimiter = first[2] ?? '.'
  const second = items.length > 1 ? numberAt(startOf(items[1])) : null
  const step = second !== null && Number(second[1]) === start ? 0 : 1
  return (itemText, index) => {
    const current = /^\d{1,9}[.)]/.exec(itemText)
    if (current === null) return undefined
    const marker = `${start + step * index}${delimiter}`
    if (marker.length !== current[0].length && itemText.includes('\n')) return undefined
    return marker + itemText.slice(current[0].length)
  }
}

/**
 * The body to write for an edit from `original` (on disk) to `updated` (the editor's body):
 * `updated`'s content, in `original`'s text wherever the two agree. See the module header.
 */
export function preserveMarkdownSource(
  original: string,
  updated: string,
  format: MarkdownBodyFormat,
): string {
  if (original === updated) return original
  const before = parse(original, format)
  const after = parse(updated, format)
  if (before === undefined || after === undefined) return updated
  const target = canonical(after)

  for (const deep of [true, false]) {
    let candidate: string | undefined
    try {
      candidate = new Splicer(original, updated, deep).body(before, after)
    } catch (err: unknown) {
      log.debug('markdown-body-splice', 'splice failed', { error: getErrorMessage(err) })
      candidate = undefined
    }
    if (candidate === undefined) continue
    const reparsed = parse(candidate, format)
    if (reparsed !== undefined && canonical(reparsed) === target) return candidate
    log.debug('markdown-body-splice', 'splice does not read back as the edit', { deep })
  }
  return updated
}
