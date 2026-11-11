/**
 * Line-level three-way merge of long text: a multi-line string, or an md/mdx body. Each side's
 * changes apply where the other left the lines alone; lines both sides changed differently are a
 * conflict region. Never writes conflict markers: in a region, the merged text holds the branch's
 * lines, and the region records all three versions for the person who resolves it.
 */

import { diff3Regions } from './diff3'

/** Lines the base and the branch both changed, differently. */
export interface TextConflictRegion {
  /** The region's lines in each version, joined by line breaks. */
  ancestor: string
  base: string
  branch: string
  /** Where the branch's lines sit in the merged text: the first line, 0-based, and how many. */
  line: number
  lines: number
}

export interface TextMergeResult {
  text: string
  /** Empty when the merge is clean. */
  regions: TextConflictRegion[]
}

/** `text` as lines, its one line break at the very end apart. */
const split = (text: string): { lines: string[]; endBreak: boolean } => {
  const endBreak = text.endsWith('\n')
  const rest = endBreak ? text.slice(0, -1) : text
  return { lines: rest === '' && !endBreak ? [] : rest.split('\n'), endBreak }
}

const sameLines = (x: readonly string[], y: readonly string[]): boolean =>
  x.length === y.length && x.every((line, i) => line === y[i])

/**
 * `base` and `branch`, both changed from `ancestor`, merged line by line. A line break at the very
 * end, the only line a serializer adds or drops by itself, is merged on its own and never makes a
 * conflict: the side that changed it wins, or the branch in a text with conflicts. Undefined when the texts are too far apart to diff in
 * time: the caller then treats each version as one whole.
 */
export function mergeText(
  ancestor: string,
  base: string,
  branch: string,
): TextMergeResult | undefined {
  const o = split(ancestor)
  const a = split(base)
  const b = split(branch)
  const regions = diff3Regions(o.lines, a.lines, b.lines)
  if (!regions) return undefined
  const versions = { ancestor: o.lines, base: a.lines, branch: b.lines }
  const out: string[] = []
  const conflicts: TextConflictRegion[] = []
  for (const region of regions) {
    if (region.stable) {
      out.push(...versions[region.side].slice(...region.span))
      continue
    }
    const [oLines, aLines, bLines] = [
      o.lines.slice(...region.ancestor),
      a.lines.slice(...region.base),
      b.lines.slice(...region.branch),
    ]
    if (sameLines(aLines, bLines)) {
      out.push(...bLines)
      continue
    }
    conflicts.push({
      ancestor: oLines.join('\n'),
      base: aLines.join('\n'),
      branch: bLines.join('\n'),
      line: out.length,
      lines: bLines.length,
    })
    out.push(...bLines)
  }
  // A conflicted text holds the branch's lines, so it holds the branch's end too.
  const endBreak = conflicts.length > 0 || o.endBreak === a.endBreak ? b.endBreak : a.endBreak
  const body = out.join('\n')
  return { text: endBreak ? `${body}\n` : body, regions: conflicts }
}
