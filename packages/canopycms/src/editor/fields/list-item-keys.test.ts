import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useListItemKeys } from './list-item-keys'

/** Keys for successive values of one list, from one hook instance. */
const keysOver = (...lists: unknown[][]): string[][] => {
  const { result } = renderHook(() => useListItemKeys())
  return lists.map((list) => result.current(list, 'list'))
}

describe('useListItemKeys with strings', () => {
  it('keeps a unique string its key through a move', () => {
    const [before, after] = keysOver(['a', 'b', 'c'], ['c', 'a', 'b'])
    expect(after).toEqual([before[2], before[0], before[1]])
  })

  it('keeps the remaining strings their keys through a remove', () => {
    const [before, after] = keysOver(['a', 'b', 'c'], ['a', 'c'])
    expect(after).toEqual([before[0], before[2]])
  })

  it('keeps the existing strings their keys through an append, and gives the new one a fresh key', () => {
    const [before, after] = keysOver(['a', 'b'], ['a', 'b', 'c'])
    expect(after.slice(0, 2)).toEqual(before)
    expect(before).not.toContain(after[2])
  })

  it('gives a string put back after a remove its old key', () => {
    const [before, , restored] = keysOver(['a', 'b', 'c'], ['a', 'c'], ['a', 'b', 'c'])
    expect(restored).toEqual(before)
  })

  it('keeps the position its key when a string is replaced in place', () => {
    const [before, after] = keysOver(['a', 'b', 'c'], ['a', 'x', 'c'])
    expect(after).toEqual(before)
  })

  it('keeps the position its key when replaced by a string the list held before', () => {
    const [before, , , after] = keysOver(
      ['a', 'b', 'c'],
      ['a', 'c'],
      ['a', 'c', 'd'],
      ['a', 'c', 'b'],
    )
    expect(after.slice(0, 2)).toEqual([before[0], before[2]])
    // `d`'s slot, not the key `b` held before it was removed.
    expect(after[2]).not.toBe(before[1])
  })

  it('leaves a repointed row its key when the string it replaced comes back ahead of it', () => {
    const [before, , after] = keysOver(['a', 'b'], ['x', 'b'], ['a', 'x', 'b'])
    // `x` took `a`'s key with its row; a returning `a` gets a fresh one rather than taking it back.
    expect(after[1]).toBe(before[0])
    expect(after[2]).toBe(before[1])
    expect(before).not.toContain(after[0])
  })

  it('keys a repeated string by position', () => {
    const [before, after] = keysOver(['a', 'b', 'a'], ['b', 'a', 'a'])
    // `b` follows its move; each `a` takes its position's key unless `b` now holds it.
    expect(after[0]).toBe(before[1])
    expect(after[2]).toBe(before[2])
    expect(before).not.toContain(after[1])
  })

  it('keeps one string separate in two lists', () => {
    const { result } = renderHook(() => useListItemKeys())
    const first = result.current(['a'], 'one')
    const second = result.current(['a'], 'two')
    expect(first[0]).not.toBe(second[0])
  })
})
