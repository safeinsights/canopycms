/**
 * Shared test utilities for hook tests.
 *
 * This file provides common setup patterns and helpers to reduce duplication
 * across hook test files.
 */

import React from 'react'
import { vi, type Mock } from 'vitest'
import { SWRConfig } from 'swr'
import { createMockApiClient, type MockApiClient } from '../../../api/__test__/mock-client'
import { ApiClientProvider } from '../../context'

/**
 * Setup mock API client for hook tests.
 *
 * This helper handles the common pattern of:
 * 1. Creating a mock API client
 * 2. Injecting it into the createApiClient factory
 *
 * @returns The mock API client instance
 *
 * @example
 * ```ts
 * let mockClient: MockApiClient
 *
 * beforeEach(async () => {
 *   mockClient = await setupMockApiClient()
 * })
 * ```
 */
export async function setupMockApiClient(): Promise<MockApiClient> {
  const { createApiClient } = await import('../../../api')
  const mockClient = createMockApiClient()
  vi.mocked(createApiClient).mockReturnValue(mockClient as any)
  return mockClient
}

/**
 * Create a wrapper component that provides the mock API client via context,
 * plus an SWR cache isolated to this wrapper instance.
 *
 * The isolated cache (`provider: () => new Map()`) matters: several hooks
 * (useBranchManager, useEntryManager, useCommentSystem) now read through
 * SWR-backed data hooks keyed by resource/branch (e.g. "canopy:branches",
 * "canopy:entries:main"). Without a fresh cache per wrapper, tests across
 * this file (and other hook test files in the same worker) would all share
 * SWR's real global cache and collide on those keys -- a later test could
 * see an earlier test's mocked response instead of its own. `dedupingInterval`
 * matches the production `SWRProvider` (2000ms) rather than 0: the manager
 * hooks' explicit reload functions (loadBranches, loadComments,
 * refreshEntries) always issue a fresh, un-deduped fetch regardless of this
 * value -- see their doc comments -- so a non-zero interval here doesn't
 * risk masking a duplicate-request bug, and it's needed for dedup
 * regression tests that mount under React.StrictMode to actually observe
 * SWR's coalescing behavior.
 *
 * Use this with renderHook to provide both contexts:
 *
 * @example
 * ```ts
 * const mockClient = await setupMockApiClient()
 * const wrapper = createApiClientWrapper(mockClient)
 * const { result } = renderHook(() => useSomeHook(), { wrapper })
 * ```
 */
export function createApiClientWrapper(mockClient: MockApiClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 2000 }}>
        <ApiClientProvider client={mockClient as any}>{children}</ApiClientProvider>
      </SWRConfig>
    )
  }
}

/**
 * Like `createApiClientWrapper`, but the tree is additionally wrapped in
 * `React.StrictMode`, which double-invokes effects (mount -> cleanup ->
 * remount) in dev. Use this for dedup regression tests: without SWR's
 * request deduplication, each fetch-on-load hook (useBranchManager,
 * useEntryManager, useCommentSystem) fired its request twice under Strict
 * Mode -- exactly the duplicate-request bug this SWR migration fixes.
 *
 * @example
 * ```ts
 * const mockClient = await setupMockApiClient()
 * const wrapper = createStrictModeApiClientWrapper(mockClient)
 * const { result } = renderHook(() => useSomeHook(), { wrapper })
 * // assert the mock fetch was called exactly once, not twice
 * ```
 */
export function createStrictModeApiClientWrapper(mockClient: MockApiClient) {
  const Inner = createApiClientWrapper(mockClient)
  return function StrictWrapper({ children }: { children: React.ReactNode }) {
    return (
      <React.StrictMode>
        <Inner>{children}</Inner>
      </React.StrictMode>
    )
  }
}

/**
 * Setup mock window.location for tests that need to manipulate browser location.
 *
 * Automatically restores the original location after the test.
 *
 * @param options - Initial location values
 * @returns Cleanup function (called automatically in afterEach if used with setupTestEnvironment)
 *
 * @example
 * ```ts
 * beforeEach(() => {
 *   setupMockLocation({ href: 'http://localhost/', search: '' })
 * })
 * ```
 */
export function setupMockLocation(options: { href?: string; search?: string } = {}) {
  const originalLocation = window.location as Location

  delete (window as any).location
  ;(window as any).location = {
    href: options.href ?? 'http://localhost/',
    search: options.search ?? '',
  }

  return () => {
    ;(window as any).location = originalLocation
  }
}

/**
 * Setup mock window.history.replaceState for tests.
 *
 * @returns The mock function
 *
 * @example
 * ```ts
 * beforeEach(() => {
 *   setupMockHistory()
 * })
 * ```
 */
export function setupMockHistory(): Mock {
  const mockReplaceState = vi.fn()
  window.history.replaceState = mockReplaceState
  return mockReplaceState
}

/**
 * Setup mock console methods with automatic cleanup.
 *
 * @param methods - Console methods to mock ('error', 'warn', 'log', etc.)
 * @returns Object with spy methods and restore function
 *
 * @example
 * ```ts
 * it('handles errors silently', async () => {
 *   const { error, restore } = setupMockConsole(['error'])
 *
 *   // ... test code that logs errors
 *
 *   expect(error).toHaveBeenCalled()
 *   restore()
 * })
 * ```
 */
export function setupMockConsole(
  methods: Array<'error' | 'warn' | 'log' | 'info' | 'debug'> = ['error'],
) {
  const spies: any = {}

  for (const method of methods) {
    spies[method] = vi.spyOn(console, method).mockImplementation(() => {})
  }

  const restore = () => {
    for (const spy of Object.values(spies)) {
      ;(spy as any)?.mockRestore()
    }
  }

  return {
    ...spies,
    restore,
  } as Record<'error' | 'warn' | 'log' | 'info' | 'debug', ReturnType<typeof vi.spyOn>> & {
    restore: () => void
  }
}

/**
 * Complete test environment setup for hook tests.
 *
 * Sets up:
 * - Mock API client
 * - Mock window.location
 * - Mock window.history
 *
 * @param options - Configuration options
 * @returns Object with mock client and cleanup functions
 *
 * @example
 * ```ts
 * let mockClient: MockApiClient
 *
 * beforeEach(async () => {
 *   const setup = await setupTestEnvironment()
 *   mockClient = setup.mockClient
 * })
 * ```
 */
export async function setupTestEnvironment(
  options: {
    location?: { href?: string; search?: string }
    setupHistory?: boolean
  } = {},
) {
  const mockClient = await setupMockApiClient()

  const cleanupLocation = setupMockLocation(options.location)
  const mockHistory = options.setupHistory !== false ? setupMockHistory() : undefined

  return {
    mockClient,
    mockHistory,
    cleanup: () => {
      cleanupLocation()
    },
  }
}
