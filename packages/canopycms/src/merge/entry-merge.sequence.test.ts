/**
 * The merge over a branch's life: several syncs in a row, each merge's result becoming the
 * branch the next one merges, against the base it last took in. Some syncs are a git-level merge
 * instead ("Update branch" on the pull request), which takes the base's changes in under the
 * branch's own keys: an item keeps the key a read gave it before the base changed it. The worker
 * re-keys what it takes in as the field merge would ({@link takenIn}); where that merge disagrees,
 * a later merge meets keys that no longer hash an item's content, or that hash another item's.
 * Lists hold twins, identical items whose read keys differ only by their repeat suffix,
 * and the editor sometimes makes an item read exactly like another: where that side also dropped
 * the other, the data reads either way, and either answer passes.
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
import { mergeEntry, type KeyRemap } from './entry-merge'
import { rekeyAsMerged } from './rekey'

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
type Op =
  | 'editDetail'
  | 'editTitle'
  | 'editBoth'
  | 'becomeOther'
  | 'takeOver'
  | 'delete'
  | 'reorder'
  | 'moveAcross'
type Mode = 'editor' | 'dev' | 'devStrip' | 'devBackfill' | 'devRekey'

const OPS: Op[] = [
  'editDetail',
  'editTitle',
  'editBoth',
  'becomeOther',
  'takeOver',
  'delete',
  'reorder',
  'moveAcross',
]
const MODES: Mode[] = ['editor', 'dev', 'devStrip', 'devBackfill', 'devRekey']

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
 * as found, strips them, backfills them from content after, or both: replaces them all.
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
    // The editor's edit that makes an item read exactly like another of its list, and with
    // `takeOver` the deletion of that other.
    const like = new Map<number, number>()
    const dropped = new Set<number>()
    read.forEach((_item, k) => {
      const op = ops.get(side.ids[list][k])
      if ((op !== 'becomeOther' && op !== 'takeOver') || mode !== 'editor' || read.length < 2)
        return
      const other = (k + 1 + g.int(read.length - 1)) % read.length
      like.set(k, other)
      if (op === 'takeOver') dropped.add(other)
    })
    read.forEach((item, k) => {
      const id = side.ids[list][k]
      const op = dropped.has(k) ? 'delete' : ops.get(id)
      const next = { ...item }
      if (op === 'editDetail' || op === 'editBoth') next.detail = `${item.detail}-${name}${n}`
      if (op === 'editTitle' || op === 'editBoth') next.title = `${item.title}~${name}${n}`
      const other = like.get(k)
      if (other !== undefined) [next.title, next.detail] = [read[other].title, read[other].detail]
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
  if (mode === 'devStrip' || mode === 'devRekey') {
    for (const l of LISTS) out.file[l] = out.file[l].map(({ title, detail }) => ({ title, detail }))
  }
  // A save keys every list as a read does, which re-keys a key a list holds twice.
  if (mode === 'devBackfill' || mode === 'devRekey' || mode === 'editor') {
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
      y[field] === x[field] || y[field] === z[field]
        ? z[field]
        : z[field] === x[field]
          ? y[field]
          : undefined
    const [title, detail] = [pick('title'), pick('detail')]
    if (title === undefined || detail === undefined) return 'conflict'
    if (y.list !== x.list && z.list !== x.list && y.list !== z.list) return 'ambiguous'
    // The merge reads a move across lists as a removal and an addition: with an edit on the other
    // side, a conflict and the moved edit are both answers.
    if ((y.list !== x.list && changed(z)) || (z.list !== x.list && changed(y))) return 'ambiguous'
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
 * Twins the data cannot tell apart: in the ancestor, both sides touched one of them, unless both
 * keyed them as the editor does (`keyed`); or a side took an item out of a list while holding a
 * copy of it there, which reads as the item itself, or an item it made read like it.
 */
function twinsAmbiguous(o: Model, a: Model, b: Model, keyed: boolean, rekeyed: boolean): boolean {
  const groups = new Map<string, string[]>()
  for (const [id, item] of o) {
    const group = `${item.list}${contentOf(item)}`
    groups.set(group, [...(groups.get(group) ?? []), id])
  }
  const differs = (x: Model, id: string) => JSON.stringify(o.get(id)) !== JSON.stringify(x.get(id))
  // A hand edit that keys a list anew deals its twins' keys out by order, whichever twin is which.
  const touched = (id: string) => differs(a, id) || differs(b, id)
  if (rekeyed && [...groups.values()].some((ids) => ids.length > 1 && ids.some(touched))) {
    return true
  }
  const bothTouched =
    !keyed &&
    [...groups.values()].some(
      (ids) =>
        ids.length > 1 && ids.some((id) => differs(a, id)) && ids.some((id) => differs(b, id)),
    )
  const copyKept = (x: Model) =>
    [...o].some(
      ([id, item]) =>
        x.get(id)?.list !== item.list &&
        [...x].some(
          ([k, v]) => !o.has(k) && v.list === item.list && contentOf(v) === contentOf(item),
        ),
    )
  // Made to read like twins it took one of out of the list: which one it took is not in the data.
  const likeTwins = (x: Model) =>
    [...groups.values()].some(
      (ids) =>
        ids.length > 1 &&
        ids.some((id) => x.get(id)?.list !== o.get(id)!.list) &&
        [...x].some(
          ([k, v]) =>
            o.has(k) &&
            contentOf(o.get(k)!) !== contentOf(v) &&
            `${v.list}${contentOf(v)}` === `${o.get(ids[0])!.list}${contentOf(o.get(ids[0])!)}`,
        ),
    )
  return bothTouched || copyKept(a) || copyKept(b) || likeTwins(a) || likeTwins(b)
}

/** Whether `key` is missing or a key a read gives `item`'s content, a repeat's suffix aside. */
const hashes = (key: string | undefined, item: { title: string; detail: string }) => {
  const read = itemKeysAsRead([{ title: item.title, detail: item.detail }])[0] as string
  return key === undefined || key === read || key.startsWith(`${read}-`)
}
/** Which keys hash their content: an ancestor item's then, a side's item's now. */
type Keys = {
  wasFresh: ReadonlySet<string>
  fresh: (item: { title: string; detail: string }, id: string) => boolean
}

/**
 * `x` read the other way where it made an item of the ancestor read exactly like another ancestor
 * item it took out of that list: the two swapped, so the other item stayed as it was and the
 * edited one went where the other went, or was dropped. Swaps of different items read together too.
 */
function readAsDropped(o: Model, x: Model, keys?: Keys): Reading[] {
  const swaps: Array<[string, string]> = []
  for (const [dropped, item] of o) {
    if (x.get(dropped)?.list === item.list) continue
    for (const [holder, kept] of x) {
      if (holder === dropped || !o.has(holder) || kept.list !== item.list) continue
      if (contentOf(kept) !== contentOf(item)) continue
      // With `keys`: only an item the side changed into the other's content, not a twin all
      // along, and only where the keys leave the data reading both ways, as the alignment reads
      // them: the dropped item's key still hashed it, and the holder's is not stale on both sides.
      if (keys && contentOf(o.get(holder)!) === contentOf(item)) continue
      if (keys && !keys.wasFresh.has(dropped)) continue
      if (keys && !keys.fresh(kept, holder) && !keys.wasFresh.has(holder)) continue
      swaps.push([dropped, holder])
    }
  }
  const reads: Reading[] = []
  const grow = (from: number, read: Reading, used: ReadonlySet<string>) => {
    for (let n = from; n < swaps.length; n++) {
      const [dropped, holder] = swaps[n]
      if (used.has(dropped) || used.has(holder)) continue
      const went = x.get(dropped)
      const model = new Map(read.model)
      model.set(dropped, { ...x.get(holder)! })
      if (went) model.set(holder, went)
      else model.delete(holder)
      const next = { model, swaps: [...read.swaps, swaps[n]] }
      reads.push(next)
      grow(n + 1, next, new Set([...used, dropped, holder]))
    }
  }
  grow(0, { model: x, swaps: [] }, new Set())
  return reads
}

/** A side's model read one way, and the swaps of identity that reading made. */
type Reading = { model: Model; swaps: Array<[string, string]> }

/** `side` with the identities `swaps` exchanged, as the reading that made them names its items. */
function relabel(side: Side, swaps: ReadonlyArray<[string, string]>): Side {
  const to = new Map<string, string>()
  for (const [dropped, holder] of swaps) {
    to.set(holder, dropped)
    to.set(dropped, holder)
  }
  const ids = { items: side.ids.items, l2: side.ids.l2 }
  for (const list of LISTS) ids[list] = side.ids[list].map((id) => to.get(id) ?? id)
  return { file: side.file, ids }
}

/**
 * `file`, each item given the identity in `want` that holds its content and list: the one whose
 * key it carries in `sides` first, as identical items are told apart by their keys alone.
 * `dropped` counts items whose key names an identity `want` dropped: the merge read each as that
 * item.
 */
function identify(file: File, want: Model, sides: Side[]): Side & { dropped: number } {
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
  let dropped = 0
  const fits = (id: string, list: List, item: Item) =>
    !used.has(id) && want.get(id)?.list === list && contentOf(want.get(id)!) === contentOf(item)
  for (const list of LISTS) {
    ids[list] = file[list].map((item) => {
      const id = item._key === undefined ? undefined : byKey.get(`${list}${item._key}`)
      if (id !== undefined && !want.has(id)) dropped++
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
  return { file, ids: ids as Record<List, string[]>, dropped }
}

/**
 * Why the merged keys misname items, or undefined: a key held twice in one list, or a remap from
 * a key of the branch's to a key the merge gave another item.
 */
function keyedWrongly(mine: Side, merged: Side, remaps: readonly KeyRemap[]): string | undefined {
  for (const list of LISTS) {
    const keys = merged.file[list].flatMap(({ _key }) => _key ?? [])
    if (new Set(keys).size !== keys.length) return `${list} holds a key twice: ${keys}`
    const idOf = (side: Side, key: string) =>
      side.ids[list][side.file[list].findIndex((i) => i._key === key)]
    for (const { within, from, to } of remaps) {
      const [was, now] = [idOf(mine, from), idOf(merged, to)]
      if (within.length === 0 && was !== undefined && now !== undefined && was !== now) {
        return `${list}: a remap ${from} -> ${to} moves ${was}'s threads to ${now}`
      }
    }
  }
  return undefined
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

/** Which operations a life draws its changes from, and how the base's are made. */
type Mix = { ops: readonly Op[]; modes: readonly Mode[] }
const EVERY: Mix = { ops: OPS, modes: MODES }
/** The editor on both sides, mostly making items read like others and deleting. */
const LOOKALIKES: Mix = {
  ops: ['takeOver', 'takeOver', 'becomeOther', 'becomeOther', 'delete', 'editTitle', 'reorder'],
  modes: ['editor'],
}

/**
 * What the worker keeps of a git-level merge it takes in (worker/github-commits.ts): where the field
 * merge of the same three versions holds the same content with no conflict, git's items under the
 * field merge's keys ({@link rekeyAsMerged}), with its remaps; else git's merge as it is.
 */
function takenIn(
  o: Side,
  base: Side,
  mine: Side,
  git: Side,
  want: Model,
): { side: Side; remaps?: readonly KeyRemap[] } {
  const result = mergeEntry({
    format: 'json',
    ancestor: { data: structuredClone(o.file) },
    base: { data: structuredClone(base.file) },
    branch: { data: structuredClone(mine.file) },
    fields,
  })
  if (result.kind !== 'merged' || result.conflicts.length > 0) return { side: git }
  const rekeyed = rekeyAsMerged(git.file, result.data) as File | undefined
  if (rekeyed === undefined) return { side: git }
  const { dropped: _dropped, ...side } = identify(rekeyed, want, [mine, base])
  return { side, remaps: result.keyRemaps }
}

/** One branch's life of `syncs` syncs, each a merge or a git-level one: `merged` when all merged as meant. */
function life(seed: number, syncs: number, mix: Mix = EVERY): string {
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
  // Every sync so far merged the editor's work on both sides: keys name every item, so a
  // conflict where none is due, a key held twice, or a remap to another item is wrong too.
  let byEditor = true
  for (let sync = 1; sync <= syncs; sync++) {
    const ids = LISTS.flatMap((list) => o.ids[list])
    const branchIds = new Set(LISTS.flatMap((list) => branch.ids[list]))
    const opsA = new Map<string, Op>()
    const opsB = new Map<string, Op>()
    for (const id of ids) {
      if (g.next() < 0.5) continue
      if (g.next() < 0.5) opsA.set(id, g.pick(mix.ops))
      else if (branchIds.has(id)) opsB.set(id, g.pick(mix.ops))
    }
    const baseMode = g.pick(mix.modes)
    byEditor &&= baseMode === 'editor'
    // Making one item read like another is the editor-only case N1 found; with hand edits on the
    // other side it is the hand-edited case the heuristic can misread.
    const lookalikes = (ops: Map<string, Op>) =>
      new Map(
        [...ops].map(([id, op]) => [
          id,
          (op === 'becomeOther' || op === 'takeOver') && !byEditor ? 'editDetail' : op,
        ]),
      )
    const base = apply(o, lookalikes(opsA), 'A', baseMode, g, sync)
    const mine = apply(branch, lookalikes(opsB), 'B', 'editor', g, sync)
    const [mo, ma, mb] = [modelOf(o), modelOf(base), modelOf(mine)]
    // Relative to this sync's ancestor, the branch's earlier changes count as its own: an item
    // both sides changed is one the editor and a hand edit can disagree on, so the life ends.
    const differs = (x: Model, id: string) =>
      JSON.stringify(mo.get(id)) !== JSON.stringify(x.get(id))
    const both = [...mo.keys()].some((id) => differs(ma, id) && differs(mb, id))
    if (both && baseMode !== 'editor') break
    if (twinsAmbiguous(mo, ma, mb, byEditor, baseMode === 'devRekey')) break
    // Where a side made an item read exactly like one it dropped, the data also reads as that
    // item kept and the other dropped: either answer is right.
    // Ancestor items whose key, if any, still hashes their content.
    const wasFresh = new Set<string>()
    for (const list of LISTS) {
      o.file[list].forEach((item, k) => {
        if (hashes(item._key, item)) wasFresh.add(o.ids[list][k])
      })
    }
    const keysOf = (side: Side): Keys => {
      const keyOf = new Map<string, string | undefined>()
      for (const list of LISTS) {
        side.ids[list].forEach((id, k) => keyOf.set(id, side.file[list][k]._key))
      }
      return { wasFresh, fresh: (item, id) => hashes(keyOf.get(id), item) }
    }
    const as = (model: Model): Reading => ({ model, swaps: [] })
    const read = (changedOnly: boolean) =>
      [as(ma), ...readAsDropped(mo, ma, changedOnly ? keysOf(base) : undefined)].flatMap((x) =>
        [as(mb), ...readAsDropped(mo, mb, changedOnly ? keysOf(mine) : undefined)].map(
          (y): [Reading, Reading] => [x, y],
        ),
      )
    // Twins a side dropped read either way too, where the data allows, but in editor-only lives
    // their keys tell them apart: only an item made to read like another excuses those checks.
    const readings = read(false)
    const want = intended(mo, ma, mb)
    if (want === 'ambiguous') break
    const accepted = byEditor ? read(true) : readings
    const edited = read(true).map(([x, y]) => intended(mo, x.model, y.model))
    if (readings.length === 1 && !both && want !== 'conflict' && g.next() < 0.4) {
      const taken = takenIn(o, base, mine, gitMerged(want, base, mine), want)
      // Re-keyed, the merge's keys name items as a field merge's do; as git wrote them, they don't.
      if (taken.remaps === undefined) byEditor = false
      else if (byEditor) {
        const wrong = keyedWrongly(mine, taken.side, taken.remaps)
        if (wrong) return `seed ${seed}, sync ${sync} [editor, taken in]: ${wrong}`
      }
      branch = taken.side
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
    if (result.kind !== 'merged') break
    const at = `seed ${seed}, sync ${sync}${byEditor ? ' [editor]' : ''}`
    if (result.conflicts.length > 0) {
      if (byEditor && !edited.includes('conflict')) return `${at}: conflicts where none was due`
      break
    }
    const merged = result.data as File
    const holds = (w: Model | 'conflict' | 'ambiguous'): w is Model =>
      w !== 'conflict' &&
      w !== 'ambiguous' &&
      LISTS.every(
        (l) => JSON.stringify(merged[l].map(contentOf).sort()) === JSON.stringify(contents(w, l)),
      )
    const fitting = accepted.flatMap(([x, y]) => {
      const w = intended(mo, x.model, y.model)
      return holds(w) ? [{ w, base: relabel(base, x.swaps), mine: relabel(mine, y.swaps) }] : []
    })
    if (fitting.length === 0) {
      return `${at}: merged to ${JSON.stringify(merged)}, meant ${JSON.stringify(want === 'conflict' ? want : [...want])}`
    }
    checked++
    // The reading the merge took: one whose items its keys name, the swaps it made carried on.
    const took = fitting
      .map((f) => ({ ...f, ...identify(merged, f.w, [f.mine, f.base]) }))
      .find((f) => f.dropped === 0)
    if (!took) {
      if (byEditor) return `${at}: a merged key names an item no reading kept`
      break
    }
    // Keys name items only where the data reads one way.
    if (byEditor && edited.length === 1) {
      const wrong = keyedWrongly(took.mine, took, result.keyRemaps)
      if (wrong) return `${at}: ${wrong}`
    }
    o = took.base
    branch = { file: took.file, ids: took.ids }
  }
  return checked >= 2 ? 'merged' : 'short'
}

const lives = (count: number, mix: Mix) =>
  Array.from({ length: count }, (_, i): [number, string] => [i + 1, life(i + 1, 5, mix)])

describe('the merge over several syncs', () => {
  it('never merges wrongly across syncs when each sync changed different items', () => {
    const results = lives(20_000, EVERY)
    expect(results.filter(([, r]) => r.startsWith('seed'))).toEqual([])
    // Enough lives ran two syncs or more, so no divergence is not a vacuous pass.
    expect(results.filter(([, r]) => r === 'merged').length).toBeGreaterThan(results.length / 4)
  })

  it('never merges wrongly where the editor makes items read like others, some like one it deleted', () => {
    const results = lives(10_000, LOOKALIKES)
    expect(results.filter(([, r]) => r.startsWith('seed'))).toEqual([])
    expect(results.filter(([, r]) => r === 'merged').length).toBeGreaterThan(results.length / 4)
  })
})
