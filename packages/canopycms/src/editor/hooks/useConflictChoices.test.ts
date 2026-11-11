import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useConflictChoices } from './useConflictChoices'

const SHA = 'd'.repeat(40)

describe('useConflictChoices', () => {
  it('sends only decided choices, for the branch they were made on', () => {
    const { result } = renderHook(() => useConflictChoices('feature'))
    act(() => {
      result.current.choose('e1', 'summary', SHA, { how: 'yours' }, true)
      result.current.choose('e1', 'body', SHA, { how: 'regions', regions: { 0: 'latest' } }, false)
    })
    expect(result.current.pending('feature', 'e1')).toEqual([{ mergeSha: SHA, key: 'summary' }])
    expect(result.current.pending('other', 'e1')).toEqual([])
    expect([...result.current.pendingIds]).toEqual(['e1'])
    expect(Object.keys(result.current.choicesFor('e1'))).toEqual(['summary', 'body'])
  })

  it('counts an entry pending only while a choice of it is decided', () => {
    const { result } = renderHook(() => useConflictChoices('feature'))
    act(() => {
      result.current.choose('e1', 'body', SHA, { how: 'regions', regions: { 0: 'latest' } }, false)
    })
    expect(result.current.pendingIds.size).toBe(0)
    act(() => {
      result.current.choose('e1', 'body', SHA, { how: 'edited' }, true)
    })
    expect([...result.current.pendingIds]).toEqual(['e1'])
    act(() => {
      result.current.choose('e1', 'body', SHA, undefined, false)
    })
    expect(result.current.pendingIds.size).toBe(0)
    expect(result.current.choicesFor('e1')).toEqual({})
  })

  it('drops what a save sent, keeping choices it did not', () => {
    const { result } = renderHook(() => useConflictChoices('feature'))
    act(() => {
      result.current.choose('e1', 'summary', SHA, { how: 'latest' }, true)
      result.current.choose('e1', 'cover', SHA, { how: 'yours' }, true)
    })
    act(() => {
      result.current.sent('feature', 'e1', [{ mergeSha: SHA, key: 'summary' }])
    })
    expect(Object.keys(result.current.choicesFor('e1'))).toEqual(['cover'])
    // A save on another branch sends nothing of this one's.
    act(() => {
      result.current.sent('other', 'e1', [{ mergeSha: SHA, key: 'cover' }])
    })
    expect(Object.keys(result.current.choicesFor('e1'))).toEqual(['cover'])
  })

  it('clears an entry’s choices with its discarded drafts, or every entry’s', () => {
    const { result } = renderHook(() => useConflictChoices('feature'))
    act(() => {
      result.current.choose('e1', 'summary', SHA, { how: 'latest' }, true)
      result.current.choose('e2', 'title', SHA, { how: 'yours' }, true)
    })
    act(() => result.current.clear('e1'))
    expect([...result.current.pendingIds]).toEqual(['e2'])
    act(() => result.current.clear())
    expect(result.current.pendingIds.size).toBe(0)
  })

  it('starts empty on another branch, so no choice crosses branches', () => {
    const { result, rerender } = renderHook(({ branch }) => useConflictChoices(branch), {
      initialProps: { branch: 'feature' },
    })
    act(() => {
      result.current.choose('e1', 'summary', SHA, { how: 'latest' }, true)
    })
    rerender({ branch: 'other' })
    expect(result.current.pendingIds.size).toBe(0)
    expect(result.current.pending('other', 'e1')).toEqual([])
  })

  it('keeps only the choices for conflicts still open on their merge', () => {
    const { result } = renderHook(() => useConflictChoices('feature'))
    act(() => {
      result.current.choose('e1', 'summary', SHA, { how: 'yours' }, true)
      result.current.choose('e1', 'title', SHA, { how: 'latest' }, true)
    })
    act(() => {
      result.current.retain('e1', [
        { key: 'summary', mergeSha: SHA },
        { key: 'title', mergeSha: 'e'.repeat(40) },
      ])
    })
    expect(Object.keys(result.current.choicesFor('e1'))).toEqual(['summary'])
    act(() => result.current.retain('e1', []))
    expect(result.current.pendingIds.size).toBe(0)
  })
})
