/**
 * Shared test utilities for hook tests.
 *
 * This file provides common setup patterns and helpers to reduce duplication
 * across hook test files.
 */

import React from 'react'
import { vi } from 'vitest'
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
 * Create a wrapper component that provides the mock API client via context.
 *
 * Use this with renderHook to provide the ApiClientContext:
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
    return <ApiClientProvider client={mockClient as any}>{children}</ApiClientProvider>
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
export function setupMockHistory() {
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
