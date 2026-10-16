import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { SWRConfig, useSWRConfig } from 'swr'
import { seedUserProfiles, useSeededUserResolver, useUserMetadata } from './useUserMetadata'
import { createUserMetadataBatcher } from './user-metadata-batcher'
import type { UserSearchResult } from '../../auth/types'
import type { ApiClient } from '../context'
import {
  createMockApiClient,
  mockError,
  mockSuccess,
  type MockApiClient,
} from '../../api/__test__/mock-client'
import { mockConsole } from '../../test-utils/console-spy'

// A fresh SWR cache per hook, so one test's user never answers another's.
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SWRConfig, { value: { provider: () => new Map() } }, children)

describe('useUserMetadata', () => {
  const mockUser: UserSearchResult = {
    id: 'user-1',
    name: 'Alice Johnson',
    email: 'alice@example.com',
    avatarUrl: 'https://example.com/avatar.jpg',
  }

  it.each(['canopycms-system', 'canopycms-content-reader', 'canopycms-context'])(
    'answers the bot id %s as "CanopyCMS bot" without a lookup',
    (botId) => {
      const getUserMetadata = vi.fn()
      const { result } = renderHook(() => useUserMetadata(botId, getUserMetadata), { wrapper })
      expect(result.current.userMetadata?.name).toBe('CanopyCMS bot')
      expect(result.current.isLoading).toBe(false)
      expect(getUserMetadata).not.toHaveBeenCalled()
    },
  )

  it('returns cached user immediately if provided', () => {
    const getUserMetadata = vi.fn()

    const { result } = renderHook(() => useUserMetadata('user-1', getUserMetadata, mockUser), {
      wrapper,
    })

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

    const { result } = renderHook(() => useUserMetadata('user-1', getUserMetadata), { wrapper })

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

    const { result } = renderHook(() => useUserMetadata('anonymous', getUserMetadata), { wrapper })

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
      { initialProps: { userId: 'user-1' }, wrapper },
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

    const { result } = renderHook(() => useUserMetadata('user-1', getUserMetadata), { wrapper })

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

    const { result } = renderHook(() => useUserMetadata('user-1', getUserMetadata), { wrapper })

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

    const { result, unmount } = renderHook(() => useUserMetadata('user-1', getUserMetadata), {
      wrapper,
    })

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

    const { result } = renderHook(() => useUserMetadata('user-1', getUserMetadata), { wrapper })

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

    const { result } = renderHook(() => useUserMetadata('user-1', getUserMetadata, mockUser), {
      wrapper,
    })

    // Should use cached user
    expect(result.current.userMetadata).toEqual(mockUser)
    expect(result.current.isLoading).toBe(false)
    expect(getUserMetadata).not.toHaveBeenCalled()
  })

  describe('seedUserProfiles', () => {
    // Never settles, so whatever the badge shows came from the seed, not from the lookup.
    const pendingLookup = () => new Promise<UserSearchResult | null>(() => {})

    it('names a user from a seeded profile while the lookup is still pending', async () => {
      const { result } = renderHook(
        () => ({ swr: useSWRConfig(), badge: useUserMetadata('user-1', pendingLookup) }),
        { wrapper },
      )

      await act(async () => {
        await seedUserProfiles(result.current.swr, [{ id: 'user-1', name: 'Alice Johnson' }])
      })

      expect(result.current.badge.userMetadata).toEqual({
        id: 'user-1',
        name: 'Alice Johnson',
        email: '',
      })
      expect(result.current.badge.isLoading).toBe(false)
    })

    it('keeps the email of a user already looked up', async () => {
      // Later lookups never settle, so what follows the seed is the seed's own merge.
      const lookup = vi
        .fn<(userId: string) => Promise<UserSearchResult | null>>()
        .mockResolvedValueOnce(mockUser)
        .mockImplementation(pendingLookup)
      const { result } = renderHook(
        () => ({ swr: useSWRConfig(), badge: useUserMetadata('user-1', lookup) }),
        { wrapper },
      )
      await waitFor(() => expect(result.current.badge.userMetadata).toEqual(mockUser))

      await act(async () => {
        await seedUserProfiles(result.current.swr, [{ id: 'user-1', name: 'Alice J.' }])
      })

      expect(result.current.badge.userMetadata).toEqual({ ...mockUser, name: 'Alice J.' })
      // A record that kept its email is not looked up again.
      expect(lookup).toHaveBeenCalledTimes(1)
    })

    it('refetches, so a badge whose lookup the seed overtook still gets its email', async () => {
      let settleFirst: (user: UserSearchResult) => void = () => {}
      const lookup = vi
        .fn<(userId: string) => Promise<UserSearchResult | null>>()
        .mockImplementationOnce(() => new Promise((resolve) => (settleFirst = resolve)))
        .mockImplementation(async () => mockUser)
      const { result } = renderHook(
        () => ({ swr: useSWRConfig(), badge: useUserMetadata('user-1', lookup) }),
        { wrapper },
      )
      await waitFor(() => expect(lookup).toHaveBeenCalledTimes(1))

      await act(async () => {
        await seedUserProfiles(result.current.swr, [{ id: 'user-1', name: 'Alice Johnson' }])
      })
      await act(async () => settleFirst(mockUser))

      await waitFor(() => expect(result.current.badge.userMetadata?.email).toBe(mockUser.email))
    })

    it('refetches a changed profile that overtook a lookup, so the badge still gets its email', async () => {
      const shared = new Map()
      const sharedCache = ({ children }: { children: ReactNode }) =>
        createElement(SWRConfig, { value: { provider: () => shared } }, children)
      const { result: config } = renderHook(() => useSWRConfig(), { wrapper: sharedCache })
      await act(async () => seedUserProfiles(config.current, [{ id: 'user-1', name: 'Alice' }]))
      const lookups: Array<(user: UserSearchResult) => void> = []
      const lookup = vi
        .fn<(userId: string) => Promise<UserSearchResult | null>>()
        .mockImplementationOnce(() => new Promise((resolve) => lookups.push(resolve)))
        .mockImplementation(async () => ({ ...mockUser, name: 'Alice B' }))
      const { result: badge } = renderHook(() => useUserMetadata('user-1', lookup), {
        wrapper: sharedCache,
      })
      await waitFor(() => expect(lookup).toHaveBeenCalledTimes(1))

      await act(async () => seedUserProfiles(config.current, [{ id: 'user-1', name: 'Alice B' }]))
      await act(async () => lookups[0]?.(mockUser))

      await waitFor(() => expect(badge.current.userMetadata?.email).toBe(mockUser.email))
      expect(badge.current.userMetadata?.name).toBe('Alice B')
    })

    it('resolves while the badge lookup never answers', async () => {
      const lookup = vi.fn(pendingLookup)
      const { result } = renderHook(
        () => ({ swr: useSWRConfig(), badge: useUserMetadata('user-1', lookup) }),
        { wrapper },
      )
      await waitFor(() => expect(lookup).toHaveBeenCalledTimes(1))

      let outcome: 'seeded' | 'waiting-on-lookup' | undefined
      await act(async () => {
        outcome = await Promise.race([
          seedUserProfiles(result.current.swr, [{ id: 'user-1', name: 'Alice Johnson' }]).then(
            () => 'seeded' as const,
          ),
          new Promise<'waiting-on-lookup'>((resolve) =>
            setTimeout(() => resolve('waiting-on-lookup'), 500),
          ),
        ])
      })

      expect(outcome).toBe('seeded')
    })

    it('looks a user up once after its first seed, however often the same profile is seeded', async () => {
      let settleRefetch: (user: UserSearchResult) => void = () => {}
      const lookup = vi
        .fn<(userId: string) => Promise<UserSearchResult | null>>()
        .mockImplementationOnce(pendingLookup)
        .mockImplementationOnce(() => new Promise((resolve) => (settleRefetch = resolve)))
        .mockImplementation(pendingLookup)
      const { result } = renderHook(
        () => ({ swr: useSWRConfig(), badge: useUserMetadata('user-1', lookup) }),
        { wrapper },
      )
      await waitFor(() => expect(lookup).toHaveBeenCalledTimes(1))
      const profile = { id: 'user-1', name: 'Alice Johnson' }

      await act(async () => seedUserProfiles(result.current.swr, [profile]))
      await waitFor(() => expect(lookup).toHaveBeenCalledTimes(2))
      await act(async () => seedUserProfiles(result.current.swr, [profile]))
      // The unchanged seed wrote nothing, so the refetch in flight is still the one that counts.
      await act(async () => settleRefetch(mockUser))

      await waitFor(() => expect(result.current.badge.userMetadata?.email).toBe(mockUser.email))
      expect(lookup).toHaveBeenCalledTimes(2)
    })

    it('merges a changed profile onto a record that has no email', async () => {
      const lookup = vi.fn(pendingLookup)
      const { result } = renderHook(
        () => ({ swr: useSWRConfig(), badge: useUserMetadata('user-1', lookup) }),
        { wrapper },
      )
      await waitFor(() => expect(lookup).toHaveBeenCalledTimes(1))
      await act(async () =>
        seedUserProfiles(result.current.swr, [{ id: 'user-1', name: 'Alice Johnson' }]),
      )
      await waitFor(() => expect(lookup).toHaveBeenCalledTimes(2))

      await act(async () =>
        seedUserProfiles(result.current.swr, [
          { id: 'user-1', name: 'Alice J.', avatarUrl: 'https://example.com/a.png' },
        ]),
      )

      expect(result.current.badge.userMetadata).toEqual({
        id: 'user-1',
        name: 'Alice J.',
        avatarUrl: 'https://example.com/a.png',
        email: '',
      })
    })

    describe('when the badge looks users up through /users/batch', () => {
      let client: MockApiClient
      let consoleSpy: ReturnType<typeof mockConsole>

      beforeEach(() => {
        client = createMockApiClient()
        consoleSpy = mockConsole()
      })
      afterEach(() => consoleSpy.restore())

      // Seeds while the first batch is still in its window, then waits for the batches to settle.
      const seededBadgeAfterLookupAnswers = async () => {
        const lookup = createUserMetadataBatcher(client as unknown as ApiClient)
        const { result } = renderHook(
          () => ({ swr: useSWRConfig(), badge: useUserMetadata('user-1', lookup) }),
          { wrapper },
        )
        await act(async () =>
          seedUserProfiles(result.current.swr, [{ id: 'user-1', name: 'Alice Johnson' }]),
        )
        await waitFor(() => expect(client.permissions.batchGetUserMetadata).toHaveBeenCalled())
        await waitFor(() =>
          expect(result.current.swr.cache.get('canopy:user:user-1')?.isValidating).toBeFalsy(),
        )
        return result.current.badge
      }

      const seededName = { id: 'user-1', name: 'Alice Johnson', email: '' }

      it('keeps the seeded name when the request fails', async () => {
        client.permissions.batchGetUserMetadata.mockRejectedValue(new Error('offline'))

        const badge = await seededBadgeAfterLookupAnswers()

        expect(badge.userMetadata).toEqual(seededName)
        expect(badge.error).toBeNull()
      })

      it('keeps the seeded name when the server answers with an error', async () => {
        client.permissions.batchGetUserMetadata.mockResolvedValue(mockError(503, 'Unavailable'))

        const badge = await seededBadgeAfterLookupAnswers()

        expect(badge.userMetadata).toEqual(seededName)
        expect(badge.error).toBeNull()
      })

      it('keeps the seeded name when the directory does not know the user', async () => {
        client.permissions.batchGetUserMetadata.mockResolvedValue(mockSuccess({ users: [] }))

        const badge = await seededBadgeAfterLookupAnswers()

        expect(badge.userMetadata).toEqual(seededName)
        expect(badge.error).toBeNull()
      })
    })

    it('answers the seeded resolver without an email, even one cached by a privileged lookup', async () => {
      const { result } = renderHook(
        () => ({ swr: useSWRConfig(), resolve: useSeededUserResolver() }),
        { wrapper },
      )
      await act(async () => {
        await result.current.swr.mutate('canopy:user:user-1', mockUser, { revalidate: false })
      })

      await expect(result.current.resolve('user-1')).resolves.toEqual({ ...mockUser, email: '' })
      await expect(result.current.resolve('user-2')).resolves.toBeNull()
    })
  })
})
