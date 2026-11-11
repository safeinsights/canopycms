/**
 * The merge's identities over many generated entries rather than chosen ones: for random content
 * O and random edits of it, `merge(O, A, O) ≡ A`, `merge(O, O, B) ≡ B` and `merge(O, X, X) ≡ X`,
 * each with no conflict. The generator mixes the shapes the merge treats differently: records,
 * keyed and keyless lists, blocks in both shapes, tag lists, multi-line text, dates and empties.
 */

import { describe, expect, it } from 'vitest'

import { mergeEntry, type MergeSide } from './entry-merge'

/** mulberry32: a small seeded generator, so a failure names its seed. */
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
type Data = Record<string, unknown>

const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'tide', 'reef', 'dune', 'fern']

const leaf = (g: Gen): unknown =>
  g.pick<() => unknown>([
    () => g.pick(WORDS),
    () => g.int(100),
    () => g.next() < 0.5,
    () => null,
    () => '',
    () => new Date(Date.UTC(2026, g.int(12), 1 + g.int(28))),
    () => Array.from({ length: 1 + g.int(4) }, () => g.pick(WORDS)).join('\n') + '\n',
    () => Array.from({ length: g.int(4) }, () => g.pick(WORDS)),
  ])()

let minted = 0
const mint = () => `m${(minted++).toString(36).padStart(6, '0')}`

const record = (g: Gen, depth: number): Data => {
  const out: Data = {}
  const size = 1 + g.int(4)
  for (let i = 0; i < size; i++) out[`${g.pick(WORDS)}${i}`] = value(g, depth + 1)
  return out
}

const list = (g: Gen, depth: number): unknown[] => {
  const keyed = g.next() < 0.5
  const blocks = g.next() < 0.3
  return Array.from({ length: g.int(5) }, () => {
    const data = record(g, depth + 1)
    const item = blocks
      ? g.next() < 0.5
        ? { template: g.pick(['hero', 'quote']), value: data }
        : { _type: g.pick(['hero', 'quote']), ...data }
      : data
    return keyed ? { ...item, _key: mint() } : item
  })
}

const value = (g: Gen, depth: number): unknown => {
  if (depth > 3) return leaf(g)
  const r = g.next()
  return r < 0.55 ? leaf(g) : r < 0.75 ? record(g, depth) : list(g, depth)
}

const clone = <T>(v: T): T => structuredClone(v)

/** `v` with a few random edits: values changed, members added and removed, items moved. */
const edit = (g: Gen, v: unknown, depth = 0): unknown => {
  if (Array.isArray(v)) {
    const items = v.map((x) => (g.next() < 0.4 ? edit(g, x, depth + 1) : clone(x)))
    const r = g.next()
    if (r < 0.15 && items.length > 0) items.splice(g.int(items.length), 1)
    else if (r < 0.3 && items.every((x) => x !== null && typeof x === 'object')) {
      const added = record(g, depth + 1)
      items.splice(g.int(items.length + 1), 0, g.next() < 0.5 ? { ...added, _key: mint() } : added)
    } else if (r < 0.45 && items.length > 1) {
      const [moved] = items.splice(g.int(items.length), 1)
      items.splice(g.int(items.length + 1), 0, moved)
    }
    return items
  }
  if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
    const out: Data = {}
    for (const [k, x] of Object.entries(v)) {
      if (k === '_key' || k === 'template' || k === '_type') {
        out[k] = x
        continue
      }
      const r = g.next()
      if (r < 0.1) continue
      out[k] = r < 0.45 ? edit(g, x, depth + 1) : clone(x)
    }
    if (g.next() < 0.2) out[`added${g.int(9)}`] = value(g, depth + 1)
    return out
  }
  if (typeof v === 'string' && v.includes('\n') && g.next() < 0.6) {
    const lines = v.split('\n')
    lines[g.int(lines.length)] = g.pick(WORDS).toUpperCase()
    return lines.join('\n')
  }
  return g.next() < 0.5 ? leaf(g) : clone(v)
}

const merged = (o: MergeSide, a: MergeSide, b: MergeSide) => {
  const result = mergeEntry({ format: 'md', ancestor: o, base: a, branch: b })
  if (result.kind !== 'merged') throw new Error(result.kind)
  return result
}

describe('the merge identities hold over generated entries', () => {
  const SEEDS = 400
  it(`merge(O, A, O) ≡ A, merge(O, O, B) ≡ B and merge(O, X, X) ≡ X for ${SEEDS} seeds`, () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const g = generator(seed)
      const o: MergeSide = { data: record(g, 0), body: 'one\ntwo\nthree\n' }
      const x: MergeSide = { data: edit(g, o.data) as Data, body: 'one\nTWO\nthree\n' }
      for (const [label, a, b, expected] of [
        ['O, A, O', x, o, x],
        ['O, O, B', o, x, x],
        ['O, X, X', x, clone(x), x],
      ] as const) {
        const result = merged(clone(o), clone(a), clone(b))
        const context = `seed ${seed}: merge(${label})`
        expect(result.conflicts, context).toEqual([])
        expect(result.data, context).toStrictEqual(expected.data)
        expect(result.body, context).toBe(expected.body)
      }
    }
  })

  it('never writes a conflict marker, whatever both sides did', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const g = generator(seed)
      const o = record(g, 0)
      const result = merged({ data: o }, { data: edit(g, o) as Data }, { data: edit(g, o) as Data })
      expect(JSON.stringify(result.data), `seed ${seed}`).not.toMatch(/<{7}|>{7}|={7}|\|{7}/)
    }
  })
})
