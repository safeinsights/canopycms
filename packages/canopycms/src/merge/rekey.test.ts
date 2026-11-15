import { describe, expect, it } from 'vitest'

import { rekeyAsMerged } from './rekey'
import { valueToken } from './value-equality'

type Data = Record<string, unknown>

describe('rekeyAsMerged', () => {
  it("gives an edited twin the field merge's key, in git's order and member order", () => {
    const git = {
      title: 'T',
      items: [
        { _key: 'hK', t: 'y' },
        { _key: 'hK-2', t: 'x' },
      ],
    }
    const field = {
      items: [
        { t: 'x', _key: 'hK-2' },
        { t: 'y', _key: 'hY' },
      ],
      title: 'T',
    }
    const out = rekeyAsMerged(git, field)
    expect(out).toEqual({
      title: 'T',
      items: [
        { _key: 'hY', t: 'y' },
        { _key: 'hK-2', t: 'x' },
      ],
    })
    expect(Object.keys((out as { items: Data[] }).items[0])).toEqual(['_key', 't'])
  })

  it('matches alike items in order', () => {
    const git = {
      items: [
        { t: 'x', _key: 'a' },
        { t: 'x', _key: 'b' },
      ],
    }
    const field = {
      items: [
        { t: 'x', _key: 'c' },
        { t: 'x', _key: 'd' },
      ],
    }
    expect(rekeyAsMerged(git, field)).toEqual({
      items: [
        { t: 'x', _key: 'c' },
        { t: 'x', _key: 'd' },
      ],
    })
  })

  it('re-keys nested lists, and keys an item git wrote with none', () => {
    const git = { blocks: [{ t: 'b', items: [{ v: 1, _key: 'old' }] }] }
    const field = { blocks: [{ t: 'b', _key: 'hB', items: [{ v: 1, _key: 'new' }] }] }
    expect(rekeyAsMerged(git, field)).toEqual({
      blocks: [{ t: 'b', items: [{ v: 1, _key: 'new' }], _key: 'hB' }],
    })
  })

  it('holds no key where the field merge gives none', () => {
    expect(rekeyAsMerged({ items: [{ t: 'x', _key: 'k' }] }, { items: [{ t: 'x' }] })).toEqual({
      items: [{ t: 'x' }],
    })
  })

  it('treats empty members alike, keeping what git wrote', () => {
    expect(rekeyAsMerged({ a: 1, b: '', c: null }, { a: 1, d: [] })).toEqual({
      a: 1,
      b: '',
      c: null,
    })
  })

  it('is undefined where the content differs', () => {
    const git = { items: [{ t: 'x', _key: 'a' }], n: 1 }
    expect(rekeyAsMerged(git, { items: [{ t: 'y', _key: 'a' }], n: 1 })).toBeUndefined()
    expect(rekeyAsMerged(git, { items: [], n: 1 })).toBeUndefined()
    expect(rekeyAsMerged(git, { items: [{ t: 'x' }], n: 2 })).toBeUndefined()
    expect(rekeyAsMerged(git, { items: [{ t: 'x' }], n: 1, extra: 'v' })).toBeUndefined()
    expect(rekeyAsMerged({ tags: ['a', 'b'] }, { tags: ['b', 'a'] })).toBeUndefined()
  })

  it('keeps a member named __proto__ as a member', () => {
    const git = JSON.parse('{"__proto__": {"t": 1}, "items": [{"t": "x", "_key": "a"}]}') as Data
    const field = JSON.parse('{"__proto__": {"t": 1}, "items": [{"t": "x", "_key": "b"}]}') as Data
    const out = rekeyAsMerged(git, field) as Data
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(out.items).toEqual([{ t: 'x', _key: 'b' }])
  })
})

/** mulberry32, so a failure names its seed. */
const generator = (seed: number) => {
  let t = seed >>> 0
  const next = () => {
    t = (t + 0x6d2b79f5) >>> 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
  return { next, int: (n: number) => Math.floor(next() * n) }
}
type Gen = ReturnType<typeof generator>

const list = (g: Gen, depth: number): Data[] =>
  Array.from({ length: g.int(5) }, () => {
    const item: Data = { t: `v${g.int(3)}` }
    if (depth < 2 && g.next() < 0.3) item.items = list(g, depth + 1)
    if (g.next() < 0.8) item._key = `k${g.int(1000)}`
    return item
  })

/** `value` with every list shuffled and every item key replaced, as another merge might key it. */
const shuffleAndRekey = (g: Gen, value: unknown): unknown => {
  if (Array.isArray(value)) {
    const items = value.map((v) => shuffleAndRekey(g, v))
    for (let i = items.length - 1; i > 0; i--) {
      const j = g.int(i + 1)
      ;[items[i], items[j]] = [items[j], items[i]]
    }
    return items
  }
  if (value === null || typeof value !== 'object') return value
  const out = Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      k === '_key' ? `f${g.int(1000)}` : shuffleAndRekey(g, v),
    ]),
  )
  return out
}

const keysOf = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(keysOf)
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([k, v]) => (k === '_key' ? [String(v)] : keysOf(v)))
}

describe('rekeyAsMerged over generated entries', () => {
  it("keeps git's content and order, and the field merge's keys, for a reordered re-keyed copy", () => {
    for (let seed = 1; seed <= 2000; seed++) {
      const g = generator(seed)
      const git = { title: 'T', items: list(g, 0), l2: list(g, 0) }
      const field = shuffleAndRekey(g, git) as Data
      const out = rekeyAsMerged(git, field)
      expect(out, `seed ${seed}`).toBeDefined()
      expect(JSON.stringify(stripKeys(out)), `seed ${seed}`).toBe(JSON.stringify(stripKeys(git)))
      expect(keysOf(out).sort(), `seed ${seed}`).toEqual(keysOf(field).sort())
    }
  })

  it('is undefined once one value differs anywhere', () => {
    for (let seed = 1; seed <= 2000; seed++) {
      const g = generator(seed)
      const git = { title: 'T', items: list(g, 0) }
      if (git.items.length === 0) continue
      const field = shuffleAndRekey(g, git) as { items: Data[] }
      field.items[g.int(field.items.length)].t = 'changed'
      expect(valueToken(field) === valueToken(git), `seed ${seed}`).toBe(false)
      expect(rekeyAsMerged(git, field), `seed ${seed}`).toBeUndefined()
    }
  })
})

const stripKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripKeys)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => k !== '_key')
      .map(([k, v]) => [k, stripKeys(v)]),
  )
}
