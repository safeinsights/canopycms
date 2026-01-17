/**
 * Hook for managing internal group state
 */

import { useState, useEffect, useCallback } from 'react'
import type { InternalGroup, CanopyGroupId, CanopyUserId } from '../types'

export interface UseGroupStateOptions {
  initialGroups: InternalGroup[]
  onSave?: (groups: InternalGroup[]) => Promise<void>
}

export interface UseGroupStateResult {
  groups: InternalGroup[]
  isDirty: boolean
  isSaving: boolean
  error: string | null
  setError: (error: string | null) => void
  createGroup: (name: string, description: string) => void
  updateGroup: (groupId: CanopyGroupId, name: string, description: string) => void
  deleteGroup: (groupId: CanopyGroupId) => void
  addMember: (groupId: CanopyGroupId, userId: CanopyUserId) => void
  removeMember: (groupId: CanopyGroupId, userId: CanopyUserId) => void
  save: () => Promise<void>
  discard: () => void
}

export function useGroupState({
  initialGroups,
  onSave,
}: UseGroupStateOptions): UseGroupStateResult {
  const [groups, setGroups] = useState<InternalGroup[]>(initialGroups)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Sync groups when prop changes
  useEffect(() => {
    setGroups(initialGroups)
    setIsDirty(false)
  }, [initialGroups])

  const createGroup = useCallback((name: string, description: string) => {
    const newGroup: InternalGroup = {
      id: '' as CanopyGroupId,
      name,
      description,
      members: [],
    }
    setGroups((prev) => [...prev, newGroup])
    setIsDirty(true)
  }, [])

  const updateGroup = useCallback((groupId: CanopyGroupId, name: string, description: string) => {
    setGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, name, description } : g)))
    setIsDirty(true)
  }, [])

  const deleteGroup = useCallback((groupId: CanopyGroupId) => {
    setGroups((prev) => prev.filter((g) => g.id !== groupId))
    setIsDirty(true)
  }, [])

  const addMember = useCallback((groupId: CanopyGroupId, userId: CanopyUserId) => {
    setGroups((prev) =>
      prev.map((g) => {
        if (g.id === groupId) {
          const members = g.members || []
          if (!members.includes(userId)) {
            return { ...g, members: [...members, userId] }
          }
        }
        return g
      }),
    )
    setIsDirty(true)
  }, [])

  const removeMember = useCallback((groupId: CanopyGroupId, userId: CanopyUserId) => {
    setGroups((prev) =>
      prev.map((g) => {
        if (g.id === groupId) {
          const members = (g.members || []).filter((m) => m !== userId)
          return { ...g, members }
        }
        return g
      }),
    )
    setIsDirty(true)
  }, [])

  const save = useCallback(async () => {
    if (!onSave) return

    // Validate that Admins group is not empty
    const adminsGroup = groups.find((g) => g.id === 'Admins')
    if (!adminsGroup || !adminsGroup.members || adminsGroup.members.length === 0) {
      setError('Cannot remove the last admin. At least one admin is required.')
      return
    }

    setIsSaving(true)
    setError(null)
    try {
      await onSave(groups)
      setIsDirty(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save groups')
    } finally {
      setIsSaving(false)
    }
  }, [onSave, groups])

  const discard = useCallback(() => {
    setGroups(initialGroups)
    setIsDirty(false)
    setError(null)
  }, [initialGroups])

  return {
    groups,
    isDirty,
    isSaving,
    error,
    setError,
    createGroup,
    updateGroup,
    deleteGroup,
    addMember,
    removeMember,
    save,
    discard,
  }
}
