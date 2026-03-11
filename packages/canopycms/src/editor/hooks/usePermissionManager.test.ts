import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePermissionManager } from './usePermissionManager'
import type { MockApiClient } from '../../api/__test__/mock-client'
import { setupMockApiClient, setupMockConsole, createApiClientWrapper } from './__test__/test-utils'
import { unsafeAsPermissionPath } from '../../authorization/test-utils'

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

describe('usePermissionManager', () => {
  let mockClient: MockApiClient
  let wrapper: ReturnType<typeof createApiClientWrapper>

  beforeEach(async () => {
    mockClient = await setupMockApiClient()
    wrapper = createApiClientWrapper(mockClient)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('initializes with empty permissions', () => {
    const { result } = renderHook(() => usePermissionManager({ isOpen: false }), { wrapper })

    expect(result.current.permissionsData).toEqual([])
    expect(result.current.permissionsLoading).toBe(false)
  })

  it('loads permissions when isOpen becomes true', async () => {
    const mockPermissions = [
      { path: unsafeAsPermissionPath('/content/pages'), edit: { allowedGroups: ['editors'] } },
      { path: unsafeAsPermissionPath('/content/posts'), read: { allowedGroups: ['writers'] } },
    ]

    mockClient.permissions.get.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { permissions: mockPermissions },
    })

    const { result } = renderHook(() => usePermissionManager({ isOpen: true }), { wrapper })

    // Should start loading
    expect(result.current.permissionsLoading).toBe(true)

    await waitFor(() => {
      expect(result.current.permissionsLoading).toBe(false)
    })

    expect(result.current.permissionsData).toEqual(mockPermissions)
    expect(mockClient.permissions.get).toHaveBeenCalled()
  })

  it('handles load permissions error', async () => {
    const { error, restore } = setupMockConsole(['error'])
    mockClient.permissions.get.mockResolvedValueOnce({
      ok: false,
      status: 500,
    })

    const { result } = renderHook(() => usePermissionManager({ isOpen: true }), { wrapper })

    await waitFor(() => {
      expect(result.current.permissionsLoading).toBe(false)
    })

    expect(result.current.permissionsData).toEqual([])
    restore()
  })

  it('saves permissions successfully', async () => {
    const mockPermissions = [{ path: unsafeAsPermissionPath('/content/pages'), edit: { allowedGroups: ['editors'] } }]

    // Mock initial load
    mockClient.permissions.get.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { permissions: [] },
    })

    const { result } = renderHook(() => usePermissionManager({ isOpen: true }), { wrapper })

    await waitFor(() => {
      expect(result.current.permissionsLoading).toBe(false)
    })

    // Mock save
    mockClient.permissions.update.mockResolvedValueOnce({
      ok: true,
      status: 200,
    })

    // Mock reload after save
    mockClient.permissions.get.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { permissions: mockPermissions },
    })

    await result.current.handleSavePermissions(mockPermissions)

    await waitFor(() => {
      expect(result.current.permissionsData).toEqual(mockPermissions)
    })

    expect(mockClient.permissions.update).toHaveBeenCalledWith({ permissions: mockPermissions })
  })

  it('handles save permissions error', async () => {
    mockClient.permissions.update.mockResolvedValueOnce({
      ok: false,
      status: 500,
      error: 'Save failed',
    })

    const { result } = renderHook(() => usePermissionManager({ isOpen: false }), { wrapper })

    await expect(result.current.handleSavePermissions([])).rejects.toThrow('Save failed')
  })

  it('lists groups successfully', async () => {
    const mockGroups = [
      { id: 'group1', name: 'Editors' },
      { id: 'group2', name: 'Writers' },
    ]

    mockClient.permissions.listGroups.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { groups: mockGroups },
    })

    const { result } = renderHook(() => usePermissionManager({ isOpen: false }), { wrapper })

    const groups = await result.current.handleListGroups()

    expect(groups).toEqual(mockGroups)
    expect(mockClient.permissions.listGroups).toHaveBeenCalled()
  })

  it('handles list groups error', async () => {
    mockClient.permissions.listGroups.mockResolvedValueOnce({
      ok: false,
      status: 500,
    })

    const { result } = renderHook(() => usePermissionManager({ isOpen: false }), { wrapper })

    const groups = await result.current.handleListGroups()

    expect(groups).toEqual([])
  })

  it('does not load permissions when isOpen is false', async () => {
    const { result } = renderHook(() => usePermissionManager({ isOpen: false }), { wrapper })

    expect(result.current.permissionsLoading).toBe(false)
    expect(mockClient.permissions.get).not.toHaveBeenCalled()
  })

  it('can manually reload permissions', async () => {
    const mockPermissions = [{ path: unsafeAsPermissionPath('/content/pages'), edit: { allowedGroups: ['editors'] } }]

    mockClient.permissions.get.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { permissions: mockPermissions },
    })

    const { result } = renderHook(() => usePermissionManager({ isOpen: false }), { wrapper })

    await result.current.loadPermissions()

    await waitFor(() => {
      expect(result.current.permissionsData).toEqual(mockPermissions)
    })
  })
})
