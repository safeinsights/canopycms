/**
 * Line-level three-way merge of long text: a multi-line string, or an md/mdx body. Each side's
 * changes apply where the other left the lines alone; lines both sides changed differently are a
 * conflict region. Never writes conflict markers: in a region, the merged text holds the branch's
 * lines, and the region records all three versions for the person who resolves it.
 */

import { diff3MergeRegions } from 'node-diff3'

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
 * conflict: the side that changed it wins.
 */
export function mergeText(ancestor: string, base: string, branch: string): TextMergeResult {
  const o = split(ancestor)
  const a = split(base)
  const b = split(branch)
  const out: string[] = []
  const regions: TextConflictRegion[] = []
  for (const region of diff3MergeRegions(a.lines, o.lines, b.lines)) {
    if (region.stable) {
      out.push(...region.bufferContent)
      continue
    }
    const { aContent, oContent, bContent } = region
    // diff3 makes a region unstable only where both sides changed lines in it.
    if (sameLines(aContent, bContent)) {
      out.push(...bContent)
    } else {
      regions.push({
        ancestor: oContent.join('\n'),
        base: aContent.join('\n'),
        branch: bContent.join('\n'),
        line: out.length,
        lines: bContent.length,
      })
      out.push(...bContent)
    }
  }
  const endBreak = o.endBreak === a.endBreak ? b.endBreak : a.endBreak
  const body = out.join('\n')
  return { text: endBreak ? `${body}\n` : body, regions }
}
