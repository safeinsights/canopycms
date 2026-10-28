/**
 * Restyles markdown to `MARKDOWN_EXPORT_OPTIONS`'s markers IN PLACE: each normalisation Prettier
 * makes is an edit to the marker bytes of the text as typed, so every other byte (URLs, titles,
 * entities, escapes, inline code, JSX) is the edit's own by construction. A serialiser cannot
 * promise that: it writes every value from the tree, and a tree-equal rewrite of a URL or an
 * entity is invisible to a tree check.
 *
 * The normalisations, each as Prettier 3 writes them:
 * - emphasis `_`, or `*` where `_` could not delimit it (beside a word character), inside other
 *   emphasis, and after a literal `_` in its block's text (Prettier misreads `a_b _x_`);
 *   strong `**`;
 * - bullets `-`, and ordered delimiters `.`, alternating with `*` / `)` for a list that follows
 *   another; ordered numbering counting up from the first number, or all one number when the
 *   first two match, where that keeps each marker's width;
 * - `---` rules, `# x` headings for one-line setext and ATX headings, backtick fences for `~~~`;
 * - one blank line between blocks (between list items and an item's blocks, only where there
 *   was one, which keeps a list's looseness); no trailing space before a soft line ending; an
 *   escaped `_` between two letters or digits unescaped, outside links;
 * - tables padded to their columns.
 *
 * Each top-level block's edits are kept only if the text they are part of reads back as the
 * edit (`readsBack`), all at once or, failing that, block by block, so a block that cannot be
 * restyled leaves the others restyled.
 */

import { MARKDOWN_EXPORT_OPTIONS } from './markdown-export-options'

/** The parts of an mdast node the restyle and the splice read. */
export interface MdNode {
  readonly type: string
  readonly children?: readonly MdNode[]
  readonly position?: {
    readonly start: { readonly offset?: number }
    readonly end: { readonly offset?: number }
  }
  readonly ordered?: boolean | null
  readonly checked?: boolean | null
  readonly depth?: number
  readonly value?: string
  readonly align?: readonly (string | null)[] | null
}

/** Replace `[start, end)` of the source with `text`. */
interface Edit {
  readonly start: number
  readonly end: number
  readonly text: string
}

const BULLETS = [MARKDOWN_EXPORT_OPTIONS.bullet, '*'] as const
const DELIMITERS = ['.', ')'] as const
const EMPHASIS = MARKDOWN_EXPORT_OPTIONS.emphasis
const STRONG = MARKDOWN_EXPORT_OPTIONS.strong.repeat(2)
const RULE = MARKDOWN_EXPORT_OPTIONS.rule.repeat(3)

/** A character Prettier counts as part of a word: neither whitespace nor punctuation. */
const WORD_CHAR = /[^\s\p{P}\p{S}]/u
/** Where a block's text ends and the next one's begins: whitespace, and blockquote markers. */
const GAP = /^[ \t>]*(?:\r?\n[ \t>]*)+$/

function startOf(node: MdNode | undefined): number | undefined {
  return node?.position?.start.offset
}

function endOf(node: MdNode | undefined): number | undefined {
  return node?.position?.end.offset
}

function apply(source: string, edits: readonly Edit[], from = 0, to = source.length): string {
  let out = ''
  let at = from
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    if (edit.start < at || edit.end > to) continue
    out += source.slice(at, edit.start) + edit.text
    at = edit.end
  }
  return out + source.slice(at, to)
}

/**
 * Where each text or MDX expression under `node` that holds a literal `_` starts, outside links:
 * Prettier reads `[a_b](u) _x_` and `https://x/a_b _x_` correctly, but not `_` in the same text.
 */
function underscoreStarts(node: MdNode): number[] {
  if (node.type === 'link' || node.type === 'linkReference') return []
  if (node.type === 'text' || node.type === 'mdxTextExpression') {
    const start = startOf(node)
    return start !== undefined && (node.value ?? '').includes('_') ? [start] : []
  }
  return (node.children ?? []).flatMap(underscoreStarts)
}

/**
 * The number Prettier writes for item `index` of an ordered list typed with `numbers`: the first
 * keeps its number; the rest count up from it, or are all 1 when the list is typed that way
 * (its second number is 1, and so is its third when it starts at 0).
 */
export function orderedNumber(numbers: readonly number[], index: number): number {
  const [first = 1, second, third] = numbers
  if (index === 0) return first
  const ones =
    numbers.length > 1 && second === 1 && (first !== 0 || numbers.length < 3 || third === 1)
  return ones ? 1 : first + index
}

class Restyler {
  /** The marker each list is written with, its own when it is not restyled. */
  private readonly listMarker = new Map<MdNode, string>()
  /** Per block that holds phrasing, where its text nodes with a literal `_` start. */
  private readonly underscores = new Map<MdNode, number[]>()

  constructor(private readonly source: string) {}

  /** Edits for `node` and everything under it, given its ancestors (nearest last). */
  collect(node: MdNode, ancestors: readonly MdNode[], out: Edit[]): void {
    const inside = [...ancestors, node]
    switch (node.type) {
      case 'emphasis':
        this.emphasis(node, ancestors, out)
        break
      case 'strong':
        this.strong(node, out)
        break
      case 'text':
        this.text(node, ancestors, out)
        return
      case 'thematicBreak':
        this.replaceWhole(node, this.ruleIn(ancestors), out)
        return
      case 'code':
        this.fence(node, out)
        return
      case 'heading':
        this.heading(node, inside, out)
        return
      case 'table':
        this.table(node, inside, out)
        return
      default:
        break
    }
    this.children(node, inside, out)
  }

  /**
   * Edits for `parent`'s children and the gaps between them. `fixed` names children whose text
   * must stay as it is (untouched top-level blocks); their lists still count for alternation.
   */
  children(
    parent: MdNode,
    inside: readonly MdNode[],
    out: Edit[],
    fixed: (index: number) => boolean = () => false,
    outFor: (index: number) => Edit[] = () => out,
  ): void {
    const children = parent.children ?? []
    const markers = this.listMarkers(children, fixed)
    children.forEach((child, index) => {
      if (fixed(index)) return
      const edits = outFor(index)
      const marker = markers.get(child)
      if (marker !== undefined) this.list(child, marker, edits)
      this.collect(child, inside, edits)
    })
    const always = parent.type === 'root' || parent.type === 'blockquote'
    const spaced = always || parent.type === 'list' || parent.type === 'listItem'
    if (!spaced) return
    for (let index = 1; index < children.length; index++) {
      if (fixed(index) && fixed(index - 1)) continue
      this.gap(
        children[index - 1],
        children[index],
        always,
        outFor(fixed(index) ? index - 1 : index),
      )
    }
  }

  /** The marker each list among `children` takes: its own, then alternating with the one before. */
  private listMarkers(
    children: readonly MdNode[],
    fixed: (index: number) => boolean,
  ): Map<MdNode, string> {
    const markers = new Map<MdNode, string>()
    let previous: { ordered: boolean; marker: string } | undefined
    children.forEach((child, index) => {
      if (child.type !== 'list') {
        previous = undefined
        return
      }
      const ordered = Boolean(child.ordered)
      const current = this.markerOf(child)
      if (current === undefined) {
        previous = undefined
        return
      }
      let marker = current
      if (!fixed(index)) {
        const choices: readonly string[] = ordered ? DELIMITERS : BULLETS
        const next = children[index + 1]
        const nextFixed =
          next?.type === 'list' && Boolean(next.ordered) === ordered && fixed(index + 1)
            ? this.markerOf(next)
            : undefined
        const before = previous?.ordered === ordered ? previous.marker : undefined
        marker = choices.find((choice) => choice !== before && choice !== nextFixed) ?? current
        markers.set(child, marker)
      }
      this.listMarker.set(child, marker)
      previous = { ordered, marker }
    })
    return markers
  }

  /**
   * A rule's text: `---`, but inside a list Prettier writes `***`, or `---` when the list takes
   * the alternate marker.
   */
  private ruleIn(ancestors: readonly MdNode[]): string {
    const list = [...ancestors].reverse().find((a) => a.type === 'list')
    if (list === undefined) return RULE
    const marker = this.listMarker.get(list)
    return marker === BULLETS[0] || marker === DELIMITERS[0] ? '***' : RULE
  }

  /** A list's bullet, or its ordered delimiter, read from its first item. */
  private markerOf(list: MdNode): string | undefined {
    const at = startOf(list.children?.[0])
    if (at === undefined) return undefined
    if (!list.ordered) return this.source[at]
    return /^\d{1,9}([.)])/.exec(this.source.slice(at, at + 10))?.[1]
  }

  /** Item markers: the list's bullet or delimiter, and Prettier's numbering where widths allow. */
  private list(list: MdNode, marker: string, out: Edit[]): void {
    const items = list.children ?? []
    const starts = items.map(startOf)
    if (!list.ordered) {
      for (const at of starts) {
        if (at !== undefined && this.source[at] !== marker) {
          out.push({ start: at, end: at + 1, text: marker })
        }
      }
      return
    }
    const numbers = starts.map((at) =>
      at === undefined ? null : /^(\d{1,9})[.)]/.exec(this.source.slice(at, at + 11)),
    )
    const typed = numbers.map((match) => Number(match?.[1]))
    const renumber = numbers.every(
      (match, i) => match !== null && String(orderedNumber(typed, i)).length === match[1]?.length,
    )
    numbers.forEach((match, i) => {
      const at = starts[i]
      if (match === null || at === undefined) return
      const digits = match[1] ?? ''
      const wanted = renumber ? String(orderedNumber(typed, i)) : digits
      if (wanted !== digits || match[0].slice(-1) !== marker) {
        out.push({ start: at, end: at + match[0].length, text: wanted + marker })
      }
    })
  }

  /**
   * The gap between two siblings with exactly one blank line, kept in the container's own
   * prefix and line ending; where `always` is false, only a gap that had a blank line.
   */
  private gap(a: MdNode | undefined, b: MdNode | undefined, always: boolean, out: Edit[]): void {
    const end = this.contentEnd(a)
    const start = startOf(b)
    if (end === undefined || start === undefined) return
    const gap = this.source.slice(end, start)
    if (!GAP.test(gap)) return
    const lines = gap.split(/\r?\n/)
    if (!always && lines.length < 3) return
    const eol = gap.includes('\r\n') ? '\r\n' : '\n'
    const prefix = lines[lines.length - 1] ?? ''
    // Prettier keeps consecutive link reference definitions together.
    const together = a?.type === 'definition' && b?.type === 'definition'
    const text = together ? eol + prefix : eol + prefix.trimEnd() + eol + prefix
    if (text !== gap) out.push({ start: end, end: start, text })
  }

  /**
   * Where `node`'s last line of content ends: a list's position runs on over the blank lines
   * after it, which in a block quote are lines of `>`.
   */
  private contentEnd(node: MdNode | undefined): number | undefined {
    const start = startOf(node)
    let end = endOf(node)
    if (start === undefined || end === undefined) return end
    for (;;) {
      const lineStart = this.source.lastIndexOf('\n', end - 1)
      if (lineStart <= start || !/^[ \t>]*$/.test(this.source.slice(lineStart + 1, end))) break
      end = this.source[lineStart - 1] === '\r' ? lineStart - 1 : lineStart
    }
    return end
  }

  private emphasis(node: MdNode, ancestors: readonly MdNode[], out: Edit[]): void {
    const start = startOf(node)
    const end = endOf(node)
    if (start === undefined || end === undefined) return
    const open = this.source[start]
    if (open !== this.source[end - 1] || (open !== '*' && open !== '_')) return
    const marker =
      ancestors.some((a) => a.type === 'emphasis') ||
      this.besideWord(start, end) ||
      this.afterUnderscore(start, ancestors)
        ? '*'
        : EMPHASIS
    if (open === marker) return
    out.push({ start, end: start + 1, text: marker }, { start: end - 1, end, text: marker })
  }

  private strong(node: MdNode, out: Edit[]): void {
    const start = startOf(node)
    const end = endOf(node)
    if (start === undefined || end === undefined) return
    if (this.source.slice(start, start + 2) !== '__' || this.source.slice(end - 2, end) !== '__') {
      return
    }
    out.push({ start, end: start + 2, text: STRONG }, { start: end - 2, end, text: STRONG })
  }

  /** Whether the characters past the markers around `[start, end)` include a word character. */
  private besideWord(start: number, end: number): boolean {
    const markers = '*_'
    let before = start - 1
    while (before >= 0 && markers.includes(this.source[before] ?? '')) before--
    let after = end
    while (after < this.source.length && markers.includes(this.source[after] ?? '')) after++
    return WORD_CHAR.test(this.source[before] ?? ' ') || WORD_CHAR.test(this.source[after] ?? ' ')
  }

  private afterUnderscore(start: number, ancestors: readonly MdNode[]): boolean {
    const block = [...ancestors]
      .reverse()
      .find((a) => a.type === 'paragraph' || a.type === 'heading' || a.type === 'tableCell')
    if (block === undefined) return false
    let starts = this.underscores.get(block)
    if (starts === undefined) {
      starts = underscoreStarts(block)
      this.underscores.set(block, starts)
    }
    // Text in the link the emphasis is in counts as the block's own.
    const link = [...ancestors]
      .reverse()
      .find((a) => a.type === 'link' || a.type === 'linkReference')
    const inLink = (link?.children ?? []).flatMap(underscoreStarts)
    return [...starts, ...inLink].some((at) => at < start)
  }

  private text(node: MdNode, ancestors: readonly MdNode[], out: Edit[]): void {
    const start = startOf(node)
    const end = endOf(node)
    if (start === undefined || end === undefined) return
    const raw = this.source.slice(start, end)
    for (const match of raw.matchAll(/[ \t]+(?=\r?\n)/g)) {
      out.push({ start: start + match.index, end: start + match.index + match[0].length, text: '' })
    }
    if (ancestors.some((a) => a.type === 'link' || a.type === 'linkReference')) return
    // In `$` math and `[[wiki links]]`, which plugins read raw, `\_` and `_` differ.
    const block = [...ancestors]
      .reverse()
      .find((a) => a.type === 'paragraph' || a.type === 'heading' || a.type === 'tableCell')
    const blockStart = startOf(block)
    const blockEnd = endOf(block)
    if (blockStart === undefined || blockEnd === undefined) return
    if (/\$|\[\[/.test(this.source.slice(blockStart, blockEnd))) return
    for (const match of raw.matchAll(/(?<=[\p{L}\p{N}])\\_(?=[\p{L}\p{N}])/gu)) {
      out.push({ start: start + match.index, end: start + match.index + 1, text: '' })
    }
  }

  private replaceWhole(node: MdNode, text: string, out: Edit[]): void {
    const start = startOf(node)
    const end = endOf(node)
    if (start === undefined || end === undefined) return
    if (this.source.slice(start, end) !== text) out.push({ start, end, text })
  }

  /** A `~~~` fence as backticks, when nothing inside it would end a backtick fence. */
  private fence(node: MdNode, out: Edit[]): void {
    const start = startOf(node)
    const end = endOf(node)
    if (start === undefined || end === undefined) return
    const raw = this.source.slice(start, end)
    const close = /(?:\r?\n)[ \t>]*(~{3,})[ \t]*$/.exec(raw)
    if (!/^~~~(?!~)[^`\n]*\n/.test(raw) || close?.[1] === undefined || raw.includes('`')) return
    const closeAt = start + close.index + close[0].indexOf('~')
    out.push(
      { start, end: start + 3, text: '```' },
      { start: closeAt, end: closeAt + close[1].length, text: '```' },
    )
  }

  /** A one-line heading as `# x`, its content with its own edits. */
  private heading(node: MdNode, inside: readonly MdNode[], out: Edit[]): void {
    const inner: Edit[] = []
    this.children(node, inside, inner)
    const children = node.children ?? []
    const start = startOf(node)
    const end = endOf(node)
    const contentStart = startOf(children[0])
    const contentEnd = endOf(children[children.length - 1])
    if (
      start === undefined ||
      end === undefined ||
      contentStart === undefined ||
      contentEnd === undefined ||
      /[\r\n]/.test(this.source.slice(contentStart, contentEnd))
    ) {
      out.push(...inner)
      return
    }
    const content = apply(this.source, inner, contentStart, contentEnd)
    const text = `${'#'.repeat(node.depth ?? 1)} ${content}`
    if (text !== this.source.slice(start, end)) out.push({ start, end, text })
    else out.push(...inner)
  }

  /** A table padded to its columns, as Prettier pads it; its cells keep their own text. */
  private table(node: MdNode, inside: readonly MdNode[], out: Edit[]): void {
    const start = startOf(node)
    const end = endOf(node)
    if (start === undefined || end === undefined) return
    const prefix = this.source.slice(this.source.lastIndexOf('\n', start - 1) + 1, start)
    const inner: Edit[] = []
    const rows = (node.children ?? []).map((row) =>
      (row.children ?? []).map((cell) => {
        const edits: Edit[] = []
        this.children(cell, [...inside, row, cell], edits)
        inner.push(...edits)
        const content = cell.children ?? []
        const from = startOf(content[0])
        const to = endOf(content[content.length - 1])
        return from === undefined || to === undefined ? '' : apply(this.source, edits, from, to)
      }),
    )
    // Prettier pads by display width, which counts wide and emoji characters twice.
    const plain = rows.every((row) => row.every((cell) => /^[\x20-\x7e]*$/.test(cell)))
    if (!plain || !/^[ \t>]*$/.test(prefix)) {
      out.push(...inner)
      return
    }
    const align = node.align ?? []
    const columns = Math.max(...rows.map((row) => row.length), align.length)
    const widths = Array.from({ length: columns }, (_, c) =>
      Math.max(3, ...rows.map((row) => row[c]?.length ?? 0)),
    )
    const pad = (text: string, c: number): string => {
      const room = (widths[c] ?? 3) - text.length
      if (align[c] === 'right') return ' '.repeat(room) + text
      if (align[c] === 'center') {
        const left = Math.floor(room / 2)
        return ' '.repeat(left) + text + ' '.repeat(room - left)
      }
      return text + ' '.repeat(room)
    }
    const delimiter = widths.map((width, c) => {
      const a = align[c]
      if (a === 'left') return `:${'-'.repeat(width - 1)}`
      if (a === 'right') return `${'-'.repeat(width - 1)}:`
      if (a === 'center') return `:${'-'.repeat(width - 2)}:`
      return '-'.repeat(width)
    })
    const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`
    const lines = rows.map((row) => line(row.map(pad)))
    lines.splice(1, 0, line(delimiter))
    const eol = this.source.slice(start, end).includes('\r\n') ? '\r\n' : '\n'
    const text = lines.join(eol + prefix)
    if (text !== this.source.slice(start, end)) out.push({ start, end, text })
  }
}

/**
 * `source` (whose parse is `tree`) restyled in place, every top-level block for which `fixed`
 * is false; undefined when no restyle reads back. `readsBack` returns the parse of a candidate
 * when it means what `source` means.
 */
export function restyleMarkdown<T extends MdNode>(
  source: string,
  tree: MdNode,
  fixed: (index: number) => boolean,
  readsBack: (text: string) => T | undefined,
): { text: string; tree: T } | undefined {
  // Positions do not count a byte-order mark, so edits would land one byte early.
  if (source.startsWith('\uFEFF')) return undefined
  const blocks = tree.children ?? []
  const groups: Edit[][] = blocks.map(() => [])
  new Restyler(source).children(tree, [], [], fixed, (index) => groups[index] ?? [])
  const changed = groups.filter((group) => group.length > 0)
  if (changed.length === 0) return undefined

  // The whole restyle first, then halves of it, until each block that does not read back stands
  // alone: a parse per try, so a few such blocks cost a few parses each. Each parse reads the
  // whole body under the write lock, so past a budget the restyle keeps what it has.
  let kept: Edit[] = []
  let best: { text: string; tree: T } | undefined
  let budget = 4 * Math.ceil(Math.log2(changed.length + 1)) + 8
  const attempt = (tried: readonly Edit[][]): void => {
    if (budget-- <= 0) return
    const trial = [...kept, ...tried.flat()]
    const text = apply(source, trial)
    const parsed = readsBack(text)
    if (parsed !== undefined) {
      kept = trial
      best = { text, tree: parsed }
    } else if (tried.length > 1) {
      const half = Math.ceil(tried.length / 2)
      attempt(tried.slice(0, half))
      attempt(tried.slice(half))
    }
  }
  attempt(changed)
  return best
}
