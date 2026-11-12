/**
 * When a two-way diff runs out of time, the merge treats the value as one whole: a whole-field
 * conflict holding the branch's value, never a partial merge.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { mergeEntry, type MergeSide } from './entry-merge'

const timedOut = vi.hoisted(() => ({ on: false }))
vi.mock('diff', async (importOriginal) => {
  const real = await importOriginal<typeof import('diff')>()
  return {
    ...real,
    diffArrays: (...args: Parameters<typeof real.diffArrays>) =>
      timedOut.on ? undefined : real.diffArrays(...args),
  }
})

afterEach(() => {
  timedOut.on = false
})

const merge = (o: MergeSide, a: MergeSide, b: MergeSide) => {
  timedOut.on = true
  const result = mergeEntry({ format: 'md', ancestor: o, base: a, branch: b })
  if (result.kind !== 'merged') throw new Error(result.kind)
  return result
}

describe('a diff that runs out of time', () => {
  it('makes a multi-line field one whole conflict with the branch value', () => {
    const result = merge(
      { data: { notes: 'a\nb\nc\n' } },
      { data: { notes: 'A\nb\nc\n' } },
      { data: { notes: 'a\nb\nC\n' } },
    )
    expect(result.data).toEqual({ notes: 'a\nb\nC\n' })
    expect(result.conflicts).toEqual([
      {
        key: '?notes',
        dataPath: [{ field: 'notes' }],
        sidePaths: {
          ancestor: [{ field: 'notes' }],
          base: [{ field: 'notes' }],
          branch: [{ field: 'notes' }],
        },
        kind: 'changed',
        ancestor: 'a\nb\nc\n',
        base: 'A\nb\nc\n',
        branch: 'a\nb\nC\n',
      },
    ])
  })

  it('makes the body one whole conflict with the branch body', () => {
    const result = merge(
      { data: {}, body: 'a\nb\n' },
      { data: {}, body: 'A\nb\n' },
      { data: {}, body: 'a\nB\n' },
    )
    expect(result.body).toBe('a\nB\n')
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]).not.toHaveProperty('regions')
  })

  it('makes a tag list one whole conflict', () => {
    const result = merge(
      { data: { tags: ['a'] } },
      { data: { tags: ['a', 'b'] } },
      { data: { tags: ['c', 'a'] } },
    )
    expect(result.data).toEqual({ tags: ['c', 'a'] })
    expect(result.conflicts.map((c) => c.key)).toEqual(['?tags'])
  })

  it('makes a list of records one whole conflict, never a partial alignment', () => {
    const items = [
      { t: 'x', _key: 'k1' },
      { t: 'y', _key: 'k2' },
    ]
    const result = merge(
      { data: { items } },
      { data: { items: [{ t: 'x (base)', _key: 'k1' }, items[1]] } },
      { data: { items: [items[0], { t: 'y (mine)', _key: 'k2' }] } },
    )
    expect(result.data).toEqual({ items: [items[0], { t: 'y (mine)', _key: 'k2' }] })
    expect(result.conflicts.map((c) => [c.key, c.kind])).toEqual([['?items', 'changed']])
  })
})
