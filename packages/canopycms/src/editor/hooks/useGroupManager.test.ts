import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useGroupManager } from './useGroupManager'

// Mock notifications
vi.mock('@mantine/notifications', () => ({
  notifications: {
    show: vi.fn(),
  },
}))

describe('useGroupManager', () => {
  beforeEach(() => {
    global.fetch = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('initializes with empty groups', () => {
    const { result } = renderHook(() => useGroupManager({ isOpen: false }))

    expect(result.current.groupsData).toEqual([])
    expect(result.current.groupsLoading).toBe(false)
  })

  it('loads groups when isOpen becomes true', async () => {
    const mockGroups = [
      { id: 'group1', name: 'Editors', members: [] },
      { id: 'group2', name: 'Reviewers', members: [] },
    ]

    ;(global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { groups: mockGroups } }),
    })

    const { result } = renderHook(() => useGroupManager({ isOpen: true }))

    // Should start loading
    expect(result.current.groupsLoading).toBe(true)

    await waitFor(() => {
      expect(result.current.groupsLoading).toBe(false)
    })

    expect(result.current.groupsData).toEqual(mockGroups)
    expect(global.fetch).toHaveBeenCalledWith('/api/canopycms/groups/internal')
  })

  it('handles load groups error', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(global.fetch as any).mockResolvedValueOnce({
      ok: false,
    })

    const { result } = renderHook(() => useGroupManager({ isOpen: true }))

    await waitFor(() => {
      expect(result.current.groupsLoading).toBe(false)
    })

    expect(result.current.groupsData).toEqual([])
    consoleErrorSpy.mockRestore()
  })

  it('saves groups successfully', async () => {
    const mockGroups = [{ id: 'group1', name: 'Editors', members: [] }]

    // Mock initial load
    ;(global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { groups: [] } }),
    })

    const { result } = renderHook(() => useGroupManager({ isOpen: true }))

    await waitFor(() => {
      expect(result.current.groupsLoading).toBe(false)
    })

    // Mock save
    ;(global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    })

    // Mock reload after save
    ;(global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { groups: mockGroups } }),
    })

    await result.current.handleSaveGroups(mockGroups)

    await waitFor(() => {
      expect(result.current.groupsData).toEqual(mockGroups)
    })

    expect(global.fetch).toHaveBeenCalledWith('/api/canopycms/groups/internal', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groups: mockGroups }),
    })
  })

  it('handles save groups error', async () => {
    ;(global.fetch as any).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'Save failed' }),
    })

    const { result } = renderHook(() => useGroupManager({ isOpen: false }))

    await expect(result.current.handleSaveGroups([])).rejects.toThrow('Save failed')
  })

  it('searches users successfully', async () => {
    const mockUsers = [
      { id: 'user1', name: 'John Doe' },
      { id: 'user2', name: 'Jane Smith' },
    ]

    ;(global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { users: mockUsers } }),
    })

    const { result } = renderHook(() => useGroupManager({ isOpen: false }))

    const users = await result.current.handleSearchUsers('john', 10)

    expect(users).toEqual(mockUsers)
    expect(global.fetch).toHaveBeenCalledWith('/api/canopycms/users/search?query=john&limit=10')
  })

  it('handles user search error', async () => {
    ;(global.fetch as any).mockResolvedValueOnce({
      ok: false,
    })

    const { result } = renderHook(() => useGroupManager({ isOpen: false }))

    const users = await result.current.handleSearchUsers('john')

    expect(users).toEqual([])
  })

  it('searches external groups successfully', async () => {
    const mockExternalGroups = [
      { id: 'ext1', name: 'External Group 1' },
      { id: 'ext2', name: 'External Group 2' },
    ]

    ;(global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { groups: mockExternalGroups } }),
    })

    const { result } = renderHook(() => useGroupManager({ isOpen: false }))

    const groups = await result.current.handleSearchExternalGroups('external')

    expect(groups).toEqual(mockExternalGroups)
    expect(global.fetch).toHaveBeenCalledWith('/api/canopycms/groups/search?query=external')
  })

  it('handles external group search error', async () => {
    ;(global.fetch as any).mockResolvedValueOnce({
      ok: false,
    })

    const { result } = renderHook(() => useGroupManager({ isOpen: false }))

    const groups = await result.current.handleSearchExternalGroups('external')

    expect(groups).toEqual([])
  })

  it('does not load groups when isOpen is false', async () => {
    const { result } = renderHook(() => useGroupManager({ isOpen: false }))

    expect(result.current.groupsLoading).toBe(false)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('can manually reload groups', async () => {
    const mockGroups = [{ id: 'group1', name: 'Editors', members: [] }]

    ;(global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { groups: mockGroups } }),
    })

    const { result } = renderHook(() => useGroupManager({ isOpen: false }))

    await result.current.loadGroups()

    await waitFor(() => {
      expect(result.current.groupsData).toEqual(mockGroups)
    })
  })
})
