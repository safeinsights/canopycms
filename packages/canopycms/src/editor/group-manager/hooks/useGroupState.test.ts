import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useGroupState } from './useGroupState'
import type { InternalGroup, CanopyGroupId, CanopyUserId } from '../types'

const findByName = (groups: InternalGroup[], name: string): InternalGroup => {
  const group = groups.find((g) => g.name === name)
  if (!group) throw new Error(`Group not found: ${name}`)
  return group
}

// Stable reference: the hook resets state whenever the initialGroups identity
// changes, so tests must not pass a fresh array literal on every render.
const noGroups: InternalGroup[] = []

describe('useGroupState', () => {
  it('assigns unique non-empty ids to newly created groups', () => {
    const { result } = renderHook(() => useGroupState({ initialGroups: noGroups }))

    act(() => {
      result.current.createGroup('Group A', '')
      result.current.createGroup('Group B', '')
    })

    const groupA = findByName(result.current.groups, 'Group A')
    const groupB = findByName(result.current.groups, 'Group B')

    expect(groupA.id).not.toBe('')
    expect(groupB.id).not.toBe('')
    expect(groupA.id).not.toBe(groupB.id)
  })

  it('keeps memberships isolated across unsaved groups', () => {
    const { result } = renderHook(() => useGroupState({ initialGroups: noGroups }))

    act(() => {
      result.current.createGroup('Group A', '')
    })
    const idA = findByName(result.current.groups, 'Group A').id
    act(() => {
      result.current.addMember(idA, 'userA' as CanopyUserId)
    })

    act(() => {
      result.current.createGroup('Group B', '')
    })
    const idB = findByName(result.current.groups, 'Group B').id
    act(() => {
      result.current.addMember(idB, 'userB' as CanopyUserId)
    })

    const groupA = findByName(result.current.groups, 'Group A')
    const groupB = findByName(result.current.groups, 'Group B')

    expect(groupA.members).toEqual(['userA'])
    expect(groupB.members).toEqual(['userB'])
  })

  it('deletes only the targeted unsaved group', () => {
    const { result } = renderHook(() => useGroupState({ initialGroups: noGroups }))

    act(() => {
      result.current.createGroup('Group A', '')
      result.current.createGroup('Group B', '')
    })
    const idA = findByName(result.current.groups, 'Group A').id
    const idB = findByName(result.current.groups, 'Group B').id
    act(() => {
      result.current.addMember(idA, 'userA' as CanopyUserId)
      result.current.addMember(idB, 'userB' as CanopyUserId)
    })

    act(() => {
      result.current.deleteGroup(idB)
    })

    expect(result.current.groups).toHaveLength(1)
    const groupA = findByName(result.current.groups, 'Group A')
    expect(groupA.members).toEqual(['userA'])
    expect(result.current.groups.find((g) => g.name === 'Group B')).toBeUndefined()
  })

  it('updates and removes members on unsaved groups via their temp ids', () => {
    const { result } = renderHook(() => useGroupState({ initialGroups: noGroups }))

    act(() => {
      result.current.createGroup('Group A', 'original')
      result.current.createGroup('Group B', '')
    })
    const idA = findByName(result.current.groups, 'Group A').id
    const idB = findByName(result.current.groups, 'Group B').id
    act(() => {
      result.current.addMember(idA, 'userA' as CanopyUserId)
      result.current.addMember(idB, 'userB' as CanopyUserId)
      result.current.updateGroup(idA, 'Group A Renamed', 'updated')
      result.current.removeMember(idA, 'userA' as CanopyUserId)
    })

    const groupA = findByName(result.current.groups, 'Group A Renamed')
    const groupB = findByName(result.current.groups, 'Group B')

    expect(groupA.description).toBe('updated')
    expect(groupA.members).toEqual([])
    expect(groupB.members).toEqual(['userB'])
  })

  it('strips temp ids to empty strings when saving, keeping existing ids intact', async () => {
    const initialGroups: InternalGroup[] = [
      {
        id: 'Admins' as CanopyGroupId,
        name: 'Admins',
        members: ['admin1' as CanopyUserId],
      },
    ]
    const onSave = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useGroupState({ initialGroups, onSave }))

    act(() => {
      result.current.createGroup('Group A', '')
    })

    await act(async () => {
      await result.current.save()
    })

    expect(onSave).toHaveBeenCalledTimes(1)
    const saved = onSave.mock.calls[0][0] as InternalGroup[]
    expect(findByName(saved, 'Admins').id).toBe('Admins')
    expect(findByName(saved, 'Group A').id).toBe('')
  })
})
