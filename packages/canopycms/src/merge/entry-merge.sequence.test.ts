/**
 * The merge over a branch's life: several syncs in a row, each merge's result becoming the
 * branch the next one merges, against the base it last took in. An item carries the key a read
 * gave it before the base changed it, so a later merge meets keys no content of its ancestor
 * hashes to. Each sync applies known operations on both sides, the branch as the editor and the
 * base as the editor or a developer editing the file by hand, and checks that the merge either
 * reports a conflict or holds exactly what the operations meant. Relative to each sync's
 * ancestor, changes to different items never merge wrongly, and neither do the editor's changes
 * to the same item on both sides, however many syncs came before.
 */

import { describe, expect, it } from 'vitest'

import type { FieldConfig } from '../config'
import { itemKeysAsRead } from '../item-keys'
import { mergeEntry } from './entry-merge'

const text = (...names: string[]): FieldConfig[] => names.map((name) => ({ name, type: 'string' }))
const fields: FieldConfig[] = [
  { name: 'title', type: 'string' },
  { name: 'items', type: 'object', list: true, fields: text('title', 'detail') },
  { name: 'l2', type: 'object', list: true, fields: text('title', 'detail') },
]

type Item = { title: string; detail: string; _key?: string }
type File = { title: string; items: Item[]; l2: Item[] }
const LISTS = ['items', 'l2'] as const
type List = (typeof LISTS)[number]
/** What the operations meant: each item by its identity, with its values and list. */
type Model = Map<string, { title: string; detail: string; list: List }>
type Op = 'editDetail' | 'editTitle' | 'editBoth' | 'delete' | 'reorder' | 'moveAcross'
type Mode = 'editor' | 'dev' | 'devStrip' | 'devBackfill'

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

/** An item's identity: its title before any edit marked it. */
const idOf = (item: Item) => item.title.split('~')[0]

const keyAll = (list: Item[]): Item[] => {
  const keys = itemKeysAsRead(list)
  return list.map((item, i) => ({ ...item, _key: keys[i] }))
}

let minted = 0
const mint = () => `M${(minted++).toString(36).padStart(10, '0')}`

/**
 * `file` after `ops` (item identity to operation), made the way `mode` works, and the item
 * added, if any. The editor keys every item as read first; a hand edit leaves keys as found,
 * strips them, or backfills them from content after.
 */
function apply(file: File, ops: Map<string, Op>, side: string, mode: Mode, g: Gen, n: number) {
  const out: File = { title: file.title, items: [], l2: [] }
  const moved: Array<[List, Item]> = []
  for (const list of LISTS) {
    const read = mode === 'editor' ? keyAll(file[list]) : file[list].map((item) => ({ ...item }))
    for (const item of read) {
      const op = ops.get(idOf(item))
      const next = { ...item }
      if (op === 'editDetail' || op === 'editBoth') next.detail = `${item.detail}-${side}${n}`
      if (op === 'editTitle' || op === 'editBoth') next.title = `${item.title}~${side}${n}`
      if (op === 'delete') continue
      if (op === 'reorder') moved.push([list, next])
      else if (op === 'moveAcross') moved.push([list === 'items' ? 'l2' : 'items', next])
      else out[list].push(next)
    }
  }
  for (const [list, item] of moved) out[list].splice(g.int(out[list].length + 1), 0, item)
  let added: Item | undefined
  if (g.next() < 0.3) {
    const list = g.pick(LISTS)
    added = { title: `new${side}${n}`, detail: 'n' }
    const item = mode === 'editor' ? { ...added, _key: mint() } : added
    out[list].splice(g.int(out[list].length + 1), 0, item)
  }
  if (mode === 'devStrip') {
    for (const list of LISTS) out[list] = out[list].map(({ title, detail }) => ({ title, detail }))
  }
  if (mode === 'devBackfill') for (const list of LISTS) out[list] = keyAll(out[list])
  return out
}

const modelOf = (file: File): Model => {
  const model: Model = new Map()
  for (const list of LISTS) {
    for (const item of file[list]) {
      model.set(idOf(item), { title: item.title, detail: item.detail, list })
    }
  }
  return model
}

/**
 * The three models merged by identity: what the merge should hold, or `conflict` where the
 * operations owe one, or `ambiguous` where they leave more than one answer.
 */
function intended(o: Model, a: Model, b: Model): Model | 'conflict' | 'ambiguous' {
  const out: Model = new Map()
  for (const id of new Set([...o.keys(), ...a.keys(), ...b.keys()])) {
    const [x, y, z] = [o.get(id), a.get(id), b.get(id)]
    if (!x) {
      const added = y ?? z
      if (added) out.set(id, added)
      continue
    }
    const changed = (v: typeof y) => v && (v.title !== x.title || v.detail !== x.detail)
    if (!y || !z) {
      if ((!y && changed(z)) || (!z && changed(y))) return 'conflict'
      if ((!y && z && z.list !== x.list) || (!z && y && y.list !== x.list)) return 'ambiguous'
      continue
    }
    const pick = (field: 'title' | 'detail') =>
      y[field] === x[field] ? z[field] : z[field] === x[field] ? y[field] : undefined
    const [title, detail] = [pick('title'), pick('detail')]
    if (title === undefined || detail === undefined) return 'conflict'
    if (y.list !== x.list && z.list !== x.list && y.list !== z.list) return 'ambiguous'
    out.set(id, { title, detail, list: y.list !== x.list ? y.list : z.list })
  }
  return out
}

const contents = (model: Model, list: List) =>
  [...model.values()]
    .filter((item) => item.list === list)
    .map(({ title, detail }) => JSON.stringify({ title, detail }))
    .sort()

/** One branch's life of `syncs` merges: `merged` when every one merged as meant. */
function life(seed: number, syncs: number): string {
  const g = generator(seed)
  let n = 0
  const ancestor: File = { title: 'T', items: [], l2: [] }
  for (const list of LISTS) {
    ancestor[list] = Array.from({ length: 1 + g.int(4) }, () => ({
      title: `t${n++}`,
      detail: `d${g.int(3)}`,
    }))
  }
  // The branch is the editor's: its first save keys every item as read.
  let o = ancestor
  let branch: File = { ...ancestor, items: keyAll(ancestor.items), l2: keyAll(ancestor.l2) }
  let checked = 0
  for (let sync = 1; sync <= syncs; sync++) {
    const ids = LISTS.flatMap((list) => o[list].map(idOf))
    const branchIds = new Set(LISTS.flatMap((list) => branch[list].map(idOf)))
    const opsA = new Map<string, Op>()
    const opsB = new Map<string, Op>()
    for (const id of ids) {
      if (g.next() < 0.5) continue
      if (g.next() < 0.5) opsA.set(id, g.pick(OPS))
      else if (branchIds.has(id)) opsB.set(id, g.pick(OPS))
    }
    const baseMode = g.pick(MODES)
    const base = apply(o, opsA, 'A', baseMode, g, sync)
    const mine = apply(branch, opsB, 'B', 'editor', g, sync)
    const [mo, ma, mb] = [modelOf(o), modelOf(base), modelOf(mine)]
    // Relative to this sync's ancestor, the branch's earlier changes count as its own: an item
    // both sides changed is one the editor and a hand edit can disagree on, so the life ends.
    const differs = (x: Model, id: string) =>
      JSON.stringify(mo.get(id)) !== JSON.stringify(x.get(id))
    const both = [...mo.keys()].some((id) => differs(ma, id) && differs(mb, id))
    if (both && baseMode !== 'editor') break
    const want = intended(mo, ma, mb)
    if (want === 'ambiguous') break
    const result = mergeEntry({
      format: 'json',
      ancestor: { data: structuredClone(o) },
      base: { data: structuredClone(base) },
      branch: { data: structuredClone(mine) },
      fields,
    })
    if (result.kind !== 'merged' || result.conflicts.length > 0) break
    if (want === 'conflict') return `seed ${seed}, sync ${sync}: merged where a conflict was due`
    const merged = result.data as File
    for (const list of LISTS) {
      const got = merged[list].map(({ title, detail }) => JSON.stringify({ title, detail })).sort()
      if (JSON.stringify(got) !== JSON.stringify(contents(want, list))) {
        return `seed ${seed}, sync ${sync}: ${list} merged to ${JSON.stringify(got)}, meant ${JSON.stringify(contents(want, list))}`
      }
    }
    checked++
    o = base
    branch = merged
  }
  return checked >= 2 ? 'merged' : 'short'
}

describe('the merge over several syncs', () => {
  it('never merges wrongly across syncs when each sync changed different items', () => {
    const results = Array.from({ length: 2000 }, (_, i) => life(i + 1, 4))
    expect(results.filter((r) => r !== 'merged' && r !== 'short')).toEqual([])
    // Enough lives ran two syncs or more, so no divergence is not a vacuous pass.
    expect(results.filter((r) => r === 'merged').length).toBeGreaterThan(results.length / 4)
  })
})
