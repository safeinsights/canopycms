import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useGroupManager, resetApiClient } from './useGroupManager'
import type { MockApiClient } from '../../api/__test__/mock-client'
import { setupMockApiClient, setupMockConsole } from './__test__/test-utils'

// Mock the API client module
vi.mock('../../api', async () => {
  const actual = await vi.importActual('../../api')
  return {
    ...actual,
    createApiClient: vi.fn(),
  }
})

// Mock notifications
vi.mock('@mantine/notifications', () => ({
  notifications: {
    show: vi.fn(),
  },
}))

describe('useGroupManager', () => {
  let mockClient: MockApiClient

  beforeEach(async () => {
    mockClient = await setupMockApiClient()
    resetApiClient()
  })

  afterEach(() => {
    vi.clearAllMocks()
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

    mockClient.groups.getInternal.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { groups: mockGroups },
    })

    const { result } = renderHook(() => useGroupManager({ isOpen: true }))

    // Should start loading
    expect(result.current.groupsLoading).toBe(true)

    await waitFor(() => {
      expect(result.current.groupsLoading).toBe(false)
    })

    expect(result.current.groupsData).toEqual(mockGroups)
    expect(mockClient.groups.getInternal).toHaveBeenCalled()
  })

  it('handles load groups error', async () => {
    const { error, restore } = setupMockConsole(['error'])
    mockClient.groups.getInternal.mockResolvedValueOnce({
      ok: false,
      status: 500,
    })

    const { result } = renderHook(() => useGroupManager({ isOpen: true }))

    await waitFor(() => {
      expect(result.current.groupsLoading).toBe(false)
    })

    expect(result.current.groupsData).toEqual([])
    restore()
  })

  it('saves groups successfully', async () => {
    const mockGroups = [{ id: 'group1', name: 'Editors', members: [] }]

    // Mock initial load
    mockClient.groups.getInternal.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { groups: [] },
    })

    const { result } = renderHook(() => useGroupManager({ isOpen: true }))

    await waitFor(() => {
      expect(result.current.groupsLoading).toBe(false)
    })

    // Mock save
    mockClient.groups.updateInternal.mockResolvedValueOnce({
      ok: true,
      status: 200,
    })

    // Mock reload after save
    mockClient.groups.getInternal.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { groups: mockGroups },
    })

    await result.current.handleSaveGroups(mockGroups)

    await waitFor(() => {
      expect(result.current.groupsData).toEqual(mockGroups)
    })

    expect(mockClient.groups.updateInternal).toHaveBeenCalledWith(mockGroups)
  })

  it('handles save groups error', async () => {
    mockClient.groups.updateInternal.mockResolvedValueOnce({
      ok: false,
      status: 500,
      error: 'Save failed',
    })

    const { result } = renderHook(() => useGroupManager({ isOpen: false }))

    await expect(result.current.handleSaveGroups([])).rejects.toThrow('Save failed')
  })

  it('searches users successfully', async () => {
    const mockUsers = [
      { id: 'user1', name: 'John Doe' },
      { id: 'user2', name: 'Jane Smith' },
    ]

    mockClient.permissions.searchUsers.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { users: mockUsers },
    })

    const { result } = renderHook(() => useGroupManager({ isOpen: false }))

    const users = await result.current.handleSearchUsers('john', 10)

    expect(users).toEqual(mockUsers)
    expect(mockClient.permissions.searchUsers).toHaveBeenCalledWith()
  })

  it('handles user search error', async () => {
    mockClient.permissions.searchUsers.mockResolvedValueOnce({
      ok: false,
      status: 500,
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

    mockClient.groups.searchExternal.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { groups: mockExternalGroups },
    })

    const { result } = renderHook(() => useGroupManager({ isOpen: false }))

    const groups = await result.current.handleSearchExternalGroups('external')

    expect(groups).toEqual(mockExternalGroups)
    expect(mockClient.groups.searchExternal).toHaveBeenCalledWith({ q: 'external' })
  })

  it('handles external group search error', async () => {
    mockClient.groups.searchExternal.mockResolvedValueOnce({
      ok: false,
      status: 500,
    })

    const { result } = renderHook(() => useGroupManager({ isOpen: false }))

    const groups = await result.current.handleSearchExternalGroups('external')

    expect(groups).toEqual([])
  })

  it('does not load groups when isOpen is false', async () => {
    const { result } = renderHook(() => useGroupManager({ isOpen: false }))

    expect(result.current.groupsLoading).toBe(false)
    expect(mockClient.groups.getInternal).not.toHaveBeenCalled()
  })

  it('can manually reload groups', async () => {
    const mockGroups = [{ id: 'group1', name: 'Editors', members: [] }]

    mockClient.groups.getInternal.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { groups: mockGroups },
    })

    const { result } = renderHook(() => useGroupManager({ isOpen: false }))

    await result.current.loadGroups()

    await waitFor(() => {
      expect(result.current.groupsData).toEqual(mockGroups)
    })
  })
})
