/**
 * The merge against what was meant. Each case starts from an ancestor entry with two lists of
 * distinct items, applies known operations independently on two sides (edit a field or both,
 * delete, move within the list or to the other list, add an item), and checks the merge either
 * reports a conflict or holds exactly the intended items. A side works as the editor does (every
 * item keyed as read, new items with minted keys) or as a developer editing the file by hand
 * (keys left as found, stripped, or backfilled from content).
 *
 * Two invariants hold: operations on different items never merge wrongly, whatever each side is;
 * and when both sides are the editor, operations on the same item never merge wrongly either. A
 * developer's hand edit of the same item in a keyless list can still be misread: pairing such
 * items is the engine's one heuristic.
 */

import { describe, expect, it } from 'vitest'

import type { FieldConfig } from '../config'
import { itemKeysAsRead } from '../item-keys'
import { mergeEntry } from './entry-merge'

const text = (...names: string[]): FieldConfig[] => names.map((name) => ({ name, type: 'string' }))
const fields: FieldConfig[] = [
  { name: 'items', type: 'object', list: true, fields: text('title', 'detail') },
  { name: 'l2', type: 'object', list: true, fields: text('title', 'detail') },
]

type Item = { title: string; detail: string; _key?: string }
type Lists = Record<'items' | 'l2', Item[]>
type Op = 'none' | 'editDetail' | 'editTitle' | 'editBoth' | 'delete' | 'reorder' | 'moveAcross'
type Mode = 'editor' | 'dev' | 'devStrip' | 'devBackfill'

const LISTS = ['items', 'l2'] as const
const OPS: Op[] = ['editDetail', 'editTitle', 'editBoth', 'delete', 'reorder', 'moveAcross']
const MODES: Mode[] = ['editor', 'dev', 'devStrip', 'devBackfill']

const generator = (seed: number) => {
  let t = seed >>> 0
  const next = () => {
    t = (t + 0x6d2b79f5) >>> 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
  const int = (n: number) => Math.floor(next() * n)
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]
  return { next, int, pick }
}
type Gen = ReturnType<typeof generator>

const keyAll = (list: Item[]): Item[] => {
  const keys = itemKeysAsRead(list)
  return list.map((item, i) => ({ ...item, _key: keys[i] }))
}

let minted = 0
const mint = () => `M${(minted++).toString(36).padStart(10, '0')}`

/** One side's version of `o` after `ops` (per `list:index`), made the way `mode` works. */
function apply(o: Lists, ops: Map<string, Op>, side: string, mode: Mode, g: Gen): Lists {
  const out: Lists = { items: [], l2: [] }
  const moved: Array<['items' | 'l2', Item]> = []
  for (const list of LISTS) {
    const read = mode === 'editor' ? keyAll(o[list]) : o[list].map((item) => ({ ...item }))
    read.forEach((item, i) => {
      const op = ops.get(`${list}:${i}`) ?? 'none'
      const next = { ...item }
      if (op === 'editDetail' || op === 'editBoth') next.detail = `${item.detail}-${side}`
      if (op === 'editTitle' || op === 'editBoth') next.title = `${item.title}~${side}`
      if (op === 'delete') return
      if (op === 'reorder') moved.push([list, next])
      else if (op === 'moveAcross') moved.push([list === 'items' ? 'l2' : 'items', next])
      else out[list].push(next)
    })
  }
  for (const [list, item] of moved) out[list].splice(g.int(out[list].length + 1), 0, item)
  if (g.next() < 0.4) {
    const list = g.pick(LISTS)
    const item: Item = { title: `new-${side}`, detail: 'n' }
    if (mode === 'editor') item._key = mint()
    out[list].splice(g.int(out[list].length + 1), 0, item)
  }
  if (mode === 'devStrip') {
    for (const list of LISTS) out[list] = out[list].map(({ title, detail }) => ({ title, detail }))
  }
  if (mode === 'devBackfill') for (const list of LISTS) out[list] = keyAll(out[list])
  return out
}

/** What the merge should hold, and whether the operations owe a conflict. */
function intended(o: Lists, opsA: Map<string, Op>, opsB: Map<string, Op>, a: Lists, b: Lists) {
  const want: Record<string, string[]> = { items: [], l2: [] }
  let mustConflict = false
  for (const list of LISTS) {
    o[list].forEach((item, i) => {
      const [x, y] = [opsA.get(`${list}:${i}`) ?? 'none', opsB.get(`${list}:${i}`) ?? 'none']
      const detail = (op: Op) => op === 'editDetail' || op === 'editBoth'
      const title = (op: Op) => op === 'editTitle' || op === 'editBoth'
      const edits = (op: Op) => detail(op) || title(op)
      if ((detail(x) && detail(y)) || (title(x) && title(y))) mustConflict = true
      if ((x === 'delete' && edits(y)) || (y === 'delete' && edits(x))) mustConflict = true
      if (x === 'delete' || y === 'delete') return
      const across = x === 'moveAcross' || y === 'moveAcross'
      const target = across ? (list === 'items' ? 'l2' : 'items') : list
      want[target].push(
        JSON.stringify({
          title: title(x) ? `${item.title}~A` : title(y) ? `${item.title}~B` : item.title,
          detail: detail(x) ? `${item.detail}-A` : detail(y) ? `${item.detail}-B` : item.detail,
        }),
      )
    })
  }
  for (const side of [a, b]) {
    for (const list of LISTS) {
      for (const item of side[list]) {
        if (item.title.startsWith('new-')) {
          want[list].push(JSON.stringify({ title: item.title, detail: item.detail }))
        }
      }
    }
  }
  return { want, mustConflict }
}

/**
 * A case's divergence from what was meant; `merged` when it merged as meant, `skipped` when it
 * conflicted or the operations leave more than one answer.
 */
function divergence(seed: number, overlap: boolean, modes?: [Mode, Mode]): string {
  const g = generator(seed)
  const keying = g.pick(['none', 'minted', 'content'] as const)
  let n = 0
  const o: Lists = { items: [], l2: [] }
  for (const list of LISTS) {
    o[list] = Array.from({ length: g.int(5) }, () => ({ title: `t${n++}`, detail: `d${g.int(3)}` }))
    if (keying === 'minted') o[list] = o[list].map((item) => ({ ...item, _key: mint() }))
    if (keying === 'content') o[list] = keyAll(o[list])
  }
  const ids = LISTS.flatMap((list) => o[list].map((_, i) => `${list}:${i}`))
  const shared = overlap && ids.length > 0 ? g.pick(ids) : undefined
  const opsA = new Map<string, Op>()
  const opsB = new Map<string, Op>()
  for (const id of ids) {
    const op = g.next() < 0.6 ? g.pick(OPS) : 'none'
    if (id === shared) {
      opsA.set(id, g.pick(OPS))
      opsB.set(id, g.pick(OPS))
    } else if (g.next() < 0.5) opsA.set(id, op)
    else opsB.set(id, op)
  }
  // A move across and a delete of one item, or two moves across, leave no single result.
  if (shared) {
    const pair = [opsA.get(shared), opsB.get(shared)]
    const across = pair.filter((op) => op === 'moveAcross').length
    if (across === 2 || (across === 1 && pair.includes('delete'))) return 'skipped'
  }
  const [modeA, modeB] = modes ?? [g.pick(MODES), g.pick(MODES)]
  const a = apply(o, opsA, 'A', modeA, g)
  const b = apply(o, opsB, 'B', modeB, g)
  const result = mergeEntry({
    format: 'json',
    ancestor: { data: structuredClone(o) },
    base: { data: structuredClone(a) },
    branch: { data: structuredClone(b) },
    fields,
  })
  if (result.kind !== 'merged' || result.conflicts.length > 0) return 'skipped'
  const { want, mustConflict } = intended(o, opsA, opsB, a, b)
  if (mustConflict) return `seed ${seed}: merged with no conflict where one was due`
  for (const list of LISTS) {
    const got = (result.data[list] as Item[]).map((item) =>
      JSON.stringify({ title: item.title, detail: item.detail }),
    )
    if (JSON.stringify(got.sort()) !== JSON.stringify(want[list].sort())) {
      return `seed ${seed}: ${list} merged to ${JSON.stringify(got)}, meant ${JSON.stringify(want[list])}`
    }
  }
  return 'merged'
}

/** Enough cases merged cleanly and were checked, so no divergence is not a vacuous pass. */
const expectEnoughChecked = (results: string[]) =>
  expect(results.filter((r) => r === 'merged').length).toBeGreaterThan(results.length / 4)

describe('the merge against what was meant', () => {
  const SEEDS = 3000

  it('never merges wrongly when the sides changed different items, however each side works', () => {
    const results = Array.from({ length: SEEDS }, (_, i) => divergence(i + 1, false))
    expect(results.filter((r) => r !== 'merged' && r !== 'skipped')).toEqual([])
    expectEnoughChecked(results)
  })

  it('never merges wrongly when two editors changed the same item', () => {
    const results = Array.from({ length: SEEDS }, (_, i) =>
      divergence(i + 1, true, ['editor', 'editor']),
    )
    expect(results.filter((r) => r !== 'merged' && r !== 'skipped')).toEqual([])
    expectEnoughChecked(results)
  })
})
