/**
 * diff3 over sequences of strings: where the base and the branch each changed the ancestor, as
 * regions that are either one version's run of elements or a run both sides changed. Built on
 * jsdiff's Myers diff, which stays fast on long input with many equal elements (blank lines, a
 * repeated tag), where an LCS by candidate lists grows with the cube of the length.
 */

import { diffArrays } from 'diff'

/** How long one two-way diff may take before the caller treats the value as one whole. */
const DIFF_TIMEOUT_MS = 500

/** A run `[start, end)` of one version. */
type Span = [number, number]

export type Diff3Region =
  | { stable: true; side: 'ancestor' | 'base' | 'branch'; span: Span }
  | { stable: false; ancestor: Span; base: Span; branch: Span }

interface Hunk {
  side: 'base' | 'branch'
  ancestor: Span
  changed: Span
}

/** Where `changed` differs from `ancestor`, as hunks; undefined when the diff ran out of time. */
function hunks(
  ancestor: readonly string[],
  changed: readonly string[],
  side: Hunk['side'],
): Hunk[] | undefined {
  const changes = diffArrays([...ancestor], [...changed], { timeout: DIFF_TIMEOUT_MS })
  if (!changes) return undefined
  const out: Hunk[] = []
  let [o, x] = [0, 0]
  let open: Hunk | undefined
  for (const change of changes) {
    const count = change.count ?? change.value.length
    if (!change.added && !change.removed) {
      open = undefined
      o += count
      x += count
      continue
    }
    if (!open) {
      open = { side, ancestor: [o, o], changed: [x, x] }
      out.push(open)
    }
    if (change.removed) open.ancestor[1] = o += count
    else open.changed[1] = x += count
  }
  return out
}

/** The pairs of equal elements a Myers diff keeps, in order; undefined when it ran out of time. */
export function commonPairs(
  x: readonly string[],
  y: readonly string[],
): Array<[number, number]> | undefined {
  const changes = diffArrays([...x], [...y], { timeout: DIFF_TIMEOUT_MS })
  if (!changes) return undefined
  const pairs: Array<[number, number]> = []
  let [i, j] = [0, 0]
  for (const change of changes) {
    const count = change.count ?? change.value.length
    if (change.added) j += count
    else if (change.removed) i += count
    else for (let n = 0; n < count; n++) pairs.push([i++, j++])
  }
  return pairs
}

/**
 * The regions of a three-way merge of `base` and `branch` from `ancestor`, in order: hunks of the
 * two sides that overlap or touch in the ancestor make one unstable region, as in GNU diff3 and
 * git. Undefined when a diff ran out of time.
 */
export function diff3Regions(
  ancestor: readonly string[],
  base: readonly string[],
  branch: readonly string[],
): Diff3Region[] | undefined {
  const baseHunks = hunks(ancestor, base, 'base')
  const branchHunks = hunks(ancestor, branch, 'branch')
  if (!baseHunks || !branchHunks) return undefined
  const all = [...baseHunks, ...branchHunks].sort((p, q) => p.ancestor[0] - q.ancestor[0])
  const regions: Diff3Region[] = []
  let at = 0
  const advanceTo = (end: number) => {
    if (end > at) regions.push({ stable: true, side: 'ancestor', span: [at, end] })
    at = Math.max(at, end)
  }
  for (let n = 0; n < all.length; ) {
    const first = all[n]
    const [start] = first.ancestor
    let end = first.ancestor[1]
    const group = [first]
    for (n++; n < all.length && all[n].ancestor[0] <= end; n++) {
      end = Math.max(end, all[n].ancestor[1])
      group.push(all[n])
    }
    advanceTo(start)
    if (group.length === 1) {
      const { side, changed } = first
      if (changed[1] > changed[0]) regions.push({ stable: true, side, span: changed })
    } else {
      // Each side's run: its own hunks' extent, widened by the ancestor lines it left alone at
      // the edges of the region.
      const sideSpan = (side: Hunk['side']): Span => {
        const own = group.filter((h) => h.side === side)
        if (own.length === 0) return [start, end]
        const lo = Math.min(...own.map((h) => h.changed[0]))
        const hi = Math.max(...own.map((h) => h.changed[1]))
        const oLo = Math.min(...own.map((h) => h.ancestor[0]))
        const oHi = Math.max(...own.map((h) => h.ancestor[1]))
        return [lo - (oLo - start), hi + (end - oHi)]
      }
      regions.push({
        stable: false,
        ancestor: [start, end],
        base: sideSpan('base'),
        branch: sideSpan('branch'),
      })
    }
    at = Math.max(at, end)
  }
  advanceTo(ancestor.length)
  return regions
}
