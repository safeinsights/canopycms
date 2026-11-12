/**
 * The merge over a branch's life: several syncs in a row, each merge's result becoming the
 * branch the next one merges, against the base it last took in. Some syncs are a git-level merge
 * instead (a clean rebase, or "Update branch" on the pull request), which takes the base's
 * changes in under the branch's own keys: an item keeps the key a read gave it before the base
 * changed it, so a later merge meets keys that no longer hash its content, or that hash another
 * item's. Lists hold twins, identical items whose read keys differ only by their repeat suffix.
 *
 * Each item has an identity the merge never sees. Each sync applies known operations on both
 * sides, the branch as the editor and the base as the editor or a developer editing the file by
 * hand, and checks that the merge either reports a conflict or holds exactly what the operations
 * meant. Relative to each sync's ancestor, changes to different items never merge wrongly, and
 * neither do the editor's changes to the same item on both sides, however many syncs came before.
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
/** A version and each of its items' identities, list by list. */
type Side = { file: File; ids: Record<List, string[]> }
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

const keyAll = (list: Item[]): Item[] => {
  const keys = itemKeysAsRead(list)
  return list.map((item, i) => ({ ...item, _key: keys[i] }))
}

let minted = 0
const mint = () => `M${(minted++).toString(36).padStart(10, '0')}`

const contentOf = ({ title, detail }: { title: string; detail: string }) =>
  JSON.stringify({ title, detail })

/**
 * `side` after `ops` (item identity to operation), made the way `mode` works, plus an item added
 * or a copy of one, sometimes. The editor keys every item as read first; a hand edit leaves keys
 * as found, strips them, or backfills them from content after.
 */
function apply(
  side: Side,
  ops: Map<string, Op>,
  name: string,
  mode: Mode,
  g: Gen,
  n: number,
): Side {
  const out: Side = {
    file: { title: side.file.title, items: [], l2: [] },
    ids: { items: [], l2: [] },
  }
  const moved: Array<[List, Item, string, List]> = []
  const insert = (list: List, item: Item, id: string) => {
    const at = g.int(out.file[list].length + 1)
    out.file[list].splice(at, 0, item)
    out.ids[list].splice(at, 0, id)
  }
  for (const list of LISTS) {
    const read =
      mode === 'editor' ? keyAll(side.file[list]) : side.file[list].map((i) => ({ ...i }))
    read.forEach((item, k) => {
      const id = side.ids[list][k]
      const op = ops.get(id)
      const next = { ...item }
      if (op === 'editDetail' || op === 'editBoth') next.detail = `${item.detail}-${name}${n}`
      if (op === 'editTitle' || op === 'editBoth') next.title = `${item.title}~${name}${n}`
      if (op === 'delete') return
      if (op === 'reorder') moved.push([list, next, id, list])
      else if (op === 'moveAcross') moved.push([list === 'items' ? 'l2' : 'items', next, id, list])
      else {
        out.file[list].push(next)
        out.ids[list].push(id)
      }
    })
  }
  for (const [list, item, id, from] of moved) {
    // The editor never writes a key twice in one list: an item moved beside its key gets a new one.
    const taken =
      mode === 'editor' &&
      from !== list &&
      side.file[list].some((other) => other._key === item._key)
    insert(list, taken ? { ...item, _key: mint() } : item, id)
  }
  const roll = g.next()
  const list = g.pick(LISTS)
  if (roll < 0.25) {
    const added = { title: `new${name}${n}`, detail: 'n' }
    insert(list, mode === 'editor' ? { ...added, _key: mint() } : added, `new${name}${n}`)
  } else if (roll < 0.4 && out.file[list].length > 0) {
    // A copy of an item: a twin until either changes.
    const { title, detail } = out.file[list][g.int(out.file[list].length)]
    insert(
      list,
      mode === 'editor' ? { title, detail, _key: mint() } : { title, detail },
      `dup${name}${n}`,
    )
  }
  if (mode === 'devStrip') {
    for (const l of LISTS) out.file[l] = out.file[l].map(({ title, detail }) => ({ title, detail }))
  }
  // A save keys every list as a read does, which re-keys a key a list holds twice.
  if (mode === 'devBackfill' || mode === 'editor') {
    for (const l of LISTS) out.file[l] = keyAll(out.file[l])
  }
  return out
}

const modelOf = (side: Side): Model => {
  const model: Model = new Map()
  for (const list of LISTS) {
    side.file[list].forEach(({ title, detail }, k) =>
      model.set(side.ids[list][k], { title, detail, list }),
    )
  }
  return model
}

/**
 * The three models merged by identity: what the merge should hold, or `conflict` where the
 * operations owe one, or `ambiguous` where they leave more than one answer.
 */
function intended(o: Model, a: Model, b: Model): Model | 'conflict' | 'ambiguous' {
  // Both sides adding the same content to a list, new or moved in, is one addition to the merge.
  const added = (m: Model) =>
    [...m]
      .filter(([id, v]) => o.get(id)?.list !== v.list)
      .map(([id, v]) => [id, `${v.list}${contentOf(v)}`])
  const fromBase = added(a)
  if (added(b).some(([id, c]) => fromBase.some(([q, d]) => q !== id && d === c))) return 'ambiguous'
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
    .map(contentOf)
    .sort()

/**
 * Twins the data cannot tell apart: in the ancestor, both sides touched one of them; or a side
 * took an item out of a list while holding a copy of it there, which reads as the item itself.
 */
function twinsAmbiguous(o: Model, a: Model, b: Model): boolean {
  const groups = new Map<string, string[]>()
  for (const [id, item] of o) {
    const group = `${item.list}${contentOf(item)}`
    groups.set(group, [...(groups.get(group) ?? []), id])
  }
  const differs = (x: Model, id: string) => JSON.stringify(o.get(id)) !== JSON.stringify(x.get(id))
  const bothTouched = [...groups.values()].some(
    (ids) => ids.length > 1 && ids.some((id) => differs(a, id)) && ids.some((id) => differs(b, id)),
  )
  const copyKept = (x: Model) =>
    [...o].some(
      ([id, item]) =>
        x.get(id)?.list !== item.list &&
        [...x].some(
          ([k, v]) => !o.has(k) && v.list === item.list && contentOf(v) === contentOf(item),
        ),
    )
  return bothTouched || copyKept(a) || copyKept(b)
}

/**
 * A known limit: a git-level merge left an item's key on content the base changed, that key is
 * the one a read now gives another item, here or in the other list (twins read K and K-2 as
 * their order allows), and the branch has since changed the item, so neither its key nor its
 * content shows which item it is. True when the branch holds such an item and the merge, given
 * the keys the ancestor's read gives each item instead, comes out as meant. An unchanged holder
 * of such a key is not this limit: its content names its item, and the merge must place it.
 */
function staleKeyTaken(o: Side, mine: Side, base: Side, want: Model | 'conflict') {
  const readKeyOf = new Map<string, string | undefined>()
  const readAs = new Set<string>()
  const ancestorOf = new Map<string, string>()
  for (const list of LISTS) {
    itemKeysAsRead(o.file[list]).forEach((key, k) => {
      readKeyOf.set(`${list}${o.ids[list][k]}`, key)
      if (key !== undefined) readAs.add(key)
    })
    o.file[list].forEach((item, k) => ancestorOf.set(`${list}${o.ids[list][k]}`, contentOf(item)))
  }
  const ideal = structuredClone(mine.file)
  let stale = false
  for (const list of LISTS) {
    ideal[list] = ideal[list].map((item, k) => {
      const id = mine.ids[list][k]
      const key = readKeyOf.get(`${list}${id}`)
      if (key === undefined) return item
      const taken = item._key !== undefined && item._key !== key && readAs.has(item._key)
      if (taken && contentOf(item) !== ancestorOf.get(`${list}${id}`)) stale = true
      return { ...item, _key: key }
    })
  }
  if (!stale) return false
  const again = mergeEntry({
    format: 'json',
    ancestor: { data: structuredClone(o.file) },
    base: { data: structuredClone(base.file) },
    branch: { data: ideal },
    fields,
  })
  if (again.kind !== 'merged') return false
  if (want === 'conflict') return again.conflicts.length > 0
  const data = again.data as File
  return LISTS.every(
    (l) => JSON.stringify(data[l].map(contentOf).sort()) === JSON.stringify(contents(want, l)),
  )
}

/**
 * `file`, each item given the identity in `want` that holds its content and list: the one whose
 * key it carries in `sides` first, as identical items are told apart by their keys alone.
 */
function identify(file: File, want: Model, sides: Side[]): Side {
  const byKey = new Map<string, string>()
  for (const side of sides) {
    for (const list of LISTS) {
      side.file[list].forEach(({ _key }, k) => {
        if (_key !== undefined) byKey.set(`${list}${_key}`, side.ids[list][k])
      })
    }
  }
  const ids: Record<List, Array<string | undefined>> = { items: [], l2: [] }
  const used = new Set<string>()
  const fits = (id: string, list: List, item: Item) =>
    !used.has(id) && want.get(id)?.list === list && contentOf(want.get(id)!) === contentOf(item)
  for (const list of LISTS) {
    ids[list] = file[list].map((item) => {
      const id = item._key === undefined ? undefined : byKey.get(`${list}${item._key}`)
      if (id === undefined || !fits(id, list, item)) return undefined
      used.add(id)
      return id
    })
  }
  for (const list of LISTS) {
    file[list].forEach((item, k) => {
      if (ids[list][k] !== undefined) return
      const id = [...want.keys()].find((candidate) => fits(candidate, list, item))
      if (id === undefined) throw new Error(`no identity for ${contentOf(item)}`)
      used.add(id)
      ids[list][k] = id
    })
  }
  return { file, ids: ids as Record<List, string[]> }
}

/**
 * What a git-level merge makes of the branch: `want`'s values in the base's order, each item
 * keeping the key the branch's copy holds, which a field merge would have replaced.
 */
function gitMerged(want: Model, base: Side, mine: Side): Side {
  const keyOf = new Map<string, string | undefined>()
  for (const side of [base, mine]) {
    for (const list of LISTS)
      side.ids[list].forEach((id, k) => keyOf.set(id, side.file[list][k]._key))
  }
  const out: Side = {
    file: { title: mine.file.title, items: [], l2: [] },
    ids: { items: [], l2: [] },
  }
  const order = [base, mine].flatMap((side) => LISTS.flatMap((l) => side.ids[l]))
  for (const id of new Set(order)) {
    const item = want.get(id)
    if (!item) continue
    const key = keyOf.get(id)
    out.file[item.list].push({
      title: item.title,
      detail: item.detail,
      ...(key !== undefined && { _key: key }),
    })
    out.ids[item.list].push(id)
  }
  return out
}

/** One branch's life of `syncs` syncs, each a merge or a git-level one: `merged` when all merged as meant. */
function life(seed: number, syncs: number): string {
  const g = generator(seed)
  let n = 0
  const start: Side = { file: { title: 'T', items: [], l2: [] }, ids: { items: [], l2: [] } }
  for (const list of LISTS) {
    for (let k = 1 + g.int(4); k > 0; k--) {
      const twin = start.file[list].length > 0 && g.next() < 0.5
      const item = twin
        ? { ...start.file[list][g.int(start.file[list].length)] }
        : { title: `t${n}`, detail: `d${g.int(3)}` }
      start.file[list].push(item)
      start.ids[list].push(`i${n++}`)
    }
  }
  // The branch is the editor's: its first save keys every item as read.
  let o = start
  let branch: Side = {
    ids: start.ids,
    file: { ...start.file, items: keyAll(start.file.items), l2: keyAll(start.file.l2) },
  }
  let checked = 0
  for (let sync = 1; sync <= syncs; sync++) {
    const ids = LISTS.flatMap((list) => o.ids[list])
    const branchIds = new Set(LISTS.flatMap((list) => branch.ids[list]))
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
    if (twinsAmbiguous(mo, ma, mb)) break
    const want = intended(mo, ma, mb)
    if (want === 'ambiguous') break
    if (!both && want !== 'conflict' && g.next() < 0.4) {
      branch = gitMerged(want, base, mine)
      o = base
      continue
    }
    const result = mergeEntry({
      format: 'json',
      ancestor: { data: structuredClone(o.file) },
      base: { data: structuredClone(base.file) },
      branch: { data: structuredClone(mine.file) },
      fields,
    })
    if (result.kind !== 'merged' || result.conflicts.length > 0) break
    const merged = result.data as File
    const meant = (data: File) =>
      want !== 'conflict' &&
      LISTS.every(
        (l) => JSON.stringify(data[l].map(contentOf).sort()) === JSON.stringify(contents(want, l)),
      )
    if (!meant(merged)) {
      if (staleKeyTaken(o, mine, base, want)) return 'stale'
      return `seed ${seed}, sync ${sync}: merged to ${JSON.stringify(merged)}, meant ${JSON.stringify(want === 'conflict' ? want : [...want])}`
    }
    checked++
    o = base
    branch = identify(merged, want as Model, [mine, base])
  }
  return checked >= 2 ? 'merged' : 'short'
}

describe('the merge over several syncs', () => {
  it('never merges wrongly across syncs when each sync changed different items', () => {
    const results = Array.from({ length: 5000 }, (_, i) => life(i + 1, 5))
    expect(results.filter((r) => r.startsWith('seed'))).toEqual([])
    // Enough lives ran two syncs or more, so no divergence is not a vacuous pass.
    expect(results.filter((r) => r === 'merged').length).toBeGreaterThan(results.length / 4)
  })
})
