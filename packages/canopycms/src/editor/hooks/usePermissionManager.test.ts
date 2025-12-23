import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePermissionManager } from './usePermissionManager'

// Mock notifications
vi.mock('@mantine/notifications', () => ({
  notifications: {
    show: vi.fn(),
  },
}))

describe('usePermissionManager', () => {
  beforeEach(() => {
    global.fetch = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('initializes with empty permissions', () => {
    const { result } = renderHook(() => usePermissionManager({ isOpen: false }))

    expect(result.current.permissionsData).toEqual([])
    expect(result.current.permissionsLoading).toBe(false)
  })

  it('loads permissions when isOpen becomes true', async () => {
    const mockPermissions = [
      { path: '/content/pages', groups: ['editors'], access: 'write' },
      { path: '/content/posts', groups: ['writers'], access: 'read' },
    ]

    ;(global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { permissions: mockPermissions } }),
    })

    const { result } = renderHook(() => usePermissionManager({ isOpen: true }))

    // Should start loading
    expect(result.current.permissionsLoading).toBe(true)

    await waitFor(() => {
      expect(result.current.permissionsLoading).toBe(false)
    })

    expect(result.current.permissionsData).toEqual(mockPermissions)
    expect(global.fetch).toHaveBeenCalledWith('/api/canopycms/permissions')
  })

  it('handles load permissions error', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(global.fetch as any).mockResolvedValueOnce({
      ok: false,
    })

    const { result } = renderHook(() => usePermissionManager({ isOpen: true }))

    await waitFor(() => {
      expect(result.current.permissionsLoading).toBe(false)
    })

    expect(result.current.permissionsData).toEqual([])
    consoleErrorSpy.mockRestore()
  })

  it('saves permissions successfully', async () => {
    const mockPermissions = [{ path: '/content/pages', groups: ['editors'], access: 'write' }]

    // Mock initial load
    ;(global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { permissions: [] } }),
    })

    const { result } = renderHook(() => usePermissionManager({ isOpen: true }))

    await waitFor(() => {
      expect(result.current.permissionsLoading).toBe(false)
    })

    // Mock save
    ;(global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    })

    // Mock reload after save
    ;(global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { permissions: mockPermissions } }),
    })

    await result.current.handleSavePermissions(mockPermissions)

    await waitFor(() => {
      expect(result.current.permissionsData).toEqual(mockPermissions)
    })

    expect(global.fetch).toHaveBeenCalledWith('/api/canopycms/permissions', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissions: mockPermissions }),
    })
  })

  it('handles save permissions error', async () => {
    ;(global.fetch as any).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'Save failed' }),
    })

    const { result } = renderHook(() => usePermissionManager({ isOpen: false }))

    await expect(result.current.handleSavePermissions([])).rejects.toThrow('Save failed')
  })

  it('lists groups successfully', async () => {
    const mockGroups = [
      { id: 'group1', name: 'Editors' },
      { id: 'group2', name: 'Writers' },
    ]

    ;(global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { groups: mockGroups } }),
    })

    const { result } = renderHook(() => usePermissionManager({ isOpen: false }))

    const groups = await result.current.handleListGroups()

    expect(groups).toEqual(mockGroups)
    expect(global.fetch).toHaveBeenCalledWith('/api/canopycms/groups')
  })

  it('handles list groups error', async () => {
    ;(global.fetch as any).mockResolvedValueOnce({
      ok: false,
    })

    const { result } = renderHook(() => usePermissionManager({ isOpen: false }))

    const groups = await result.current.handleListGroups()

    expect(groups).toEqual([])
  })

  it('does not load permissions when isOpen is false', async () => {
    const { result } = renderHook(() => usePermissionManager({ isOpen: false }))

    expect(result.current.permissionsLoading).toBe(false)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('can manually reload permissions', async () => {
    const mockPermissions = [{ path: '/content/pages', groups: ['editors'], access: 'write' }]

    ;(global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { permissions: mockPermissions } }),
    })

    const { result } = renderHook(() => usePermissionManager({ isOpen: false }))

    await result.current.loadPermissions()

    await waitFor(() => {
      expect(result.current.permissionsData).toEqual(mockPermissions)
    })
  })
})
