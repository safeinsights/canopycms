import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useUserMetadata } from './useUserMetadata'
import type { UserSearchResult } from '../../auth/types'

describe('useUserMetadata', () => {
  const mockUser: UserSearchResult = {
    id: 'user-1',
    name: 'Alice Johnson',
    email: 'alice@example.com',
    avatarUrl: 'https://example.com/avatar.jpg',
  }

  it('returns cached user immediately if provided', () => {
    const getUserMetadata = vi.fn()

    const { result } = renderHook(() => useUserMetadata('user-1', getUserMetadata, mockUser))

    // Should return cached user immediately
    expect(result.current.userMetadata).toEqual(mockUser)
    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBe(null)

    // Should not call getUserMetadata
    expect(getUserMetadata).not.toHaveBeenCalled()
  })

  it('fetches from getUserMetadata on mount', async () => {
    const getUserMetadata = vi.fn(async (userId: string) => {
      if (userId === 'user-1') return mockUser
      return null
    })

    const { result } = renderHook(() => useUserMetadata('user-1', getUserMetadata))

    // Should be loading initially
    expect(result.current.isLoading).toBe(true)
    expect(result.current.userMetadata).toBe(null)

    // Wait for fetch to complete
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    // Should have fetched user
    expect(result.current.userMetadata).toEqual(mockUser)
    expect(result.current.error).toBe(null)
    expect(getUserMetadata).toHaveBeenCalledWith('user-1')
  })

  it('handles anonymous user without API call', async () => {
    const getUserMetadata = vi.fn()

    const { result } = renderHook(() => useUserMetadata('anonymous', getUserMetadata))

    // Should return anonymous user immediately
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.userMetadata).toEqual({
      id: 'anonymous',
      name: 'Anonymous',
      email: 'public',
    })
    expect(result.current.error).toBe(null)

    // Should not call getUserMetadata for anonymous
    expect(getUserMetadata).not.toHaveBeenCalled()
  })

  it('updates when userId changes', async () => {
    const mockUser2: UserSearchResult = {
      id: 'user-2',
      name: 'Bob Smith',
      email: 'bob@example.com',
    }

    const getUserMetadata = vi.fn(async (userId: string) => {
      if (userId === 'user-1') return mockUser
      if (userId === 'user-2') return mockUser2
      return null
    })

    const { result, rerender } = renderHook(
      ({ userId }) => useUserMetadata(userId, getUserMetadata),
      { initialProps: { userId: 'user-1' } },
    )

    // Wait for first fetch
    await waitFor(() => {
      expect(result.current.userMetadata).toEqual(mockUser)
    })

    // Change userId
    rerender({ userId: 'user-2' })

    // Should fetch new user
    await waitFor(() => {
      expect(result.current.userMetadata).toEqual(mockUser2)
    })

    expect(getUserMetadata).toHaveBeenCalledWith('user-1')
    expect(getUserMetadata).toHaveBeenCalledWith('user-2')
  })

  it('handles errors gracefully', async () => {
    const getUserMetadata = vi.fn(async () => {
      throw new Error('Network error')
    })

    const { result } = renderHook(() => useUserMetadata('user-1', getUserMetadata))

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.userMetadata).toBe(null)
    expect(result.current.error).toEqual(new Error('Network error'))
  })

  it('handles non-Error exceptions', async () => {
    const getUserMetadata = vi.fn(async () => {
      throw 'String error'
    })

    const { result } = renderHook(() => useUserMetadata('user-1', getUserMetadata))

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.userMetadata).toBe(null)
    expect(result.current.error).toEqual(new Error('Failed to fetch user'))
  })

  it('cleans up on unmount (no state updates after unmount)', async () => {
    let resolveUser: ((value: UserSearchResult) => void) | undefined
    const getUserMetadata = vi.fn(async () => {
      return new Promise<UserSearchResult>((resolve) => {
        resolveUser = resolve
      })
    })

    const { result, unmount } = renderHook(() => useUserMetadata('user-1', getUserMetadata))

    // Should be loading
    expect(result.current.isLoading).toBe(true)

    // Unmount before fetch completes
    unmount()

    // Now resolve the promise (force call it since we know it's been set)
    ;(resolveUser as (value: UserSearchResult) => void)(mockUser)

    // Wait a bit to ensure no state updates happen
    await new Promise((resolve) => setTimeout(resolve, 50))

    // No errors should be thrown (state updates on unmounted component would cause warnings)
  })

  it('handles null return from getUserMetadata', async () => {
    const getUserMetadata = vi.fn(async () => null)

    const { result } = renderHook(() => useUserMetadata('user-1', getUserMetadata))

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.userMetadata).toBe(null)
    expect(result.current.error).toBe(null)
  })

  it('skips fetch when cachedUser is provided even if getUserMetadata would return different data', async () => {
    const differentUser: UserSearchResult = {
      id: 'user-1',
      name: 'Different Name',
      email: 'different@example.com',
    }

    const getUserMetadata = vi.fn(async () => differentUser)

    const { result } = renderHook(() => useUserMetadata('user-1', getUserMetadata, mockUser))

    // Should use cached user
    expect(result.current.userMetadata).toEqual(mockUser)
    expect(result.current.isLoading).toBe(false)
    expect(getUserMetadata).not.toHaveBeenCalled()
  })
})
