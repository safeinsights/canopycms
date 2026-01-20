'use client'

/**
 * API Client Context
 *
 * Provides dependency injection for the API client via context-based pattern
 * pattern that was duplicated across 6 hooks. This enables:
 * - Clean testing via provider (no more resetApiClient() hacks)
 * - Explicit dependency
 * - No global mutable state
 */

import React, { createContext, useContext, useMemo } from 'react'
import { createApiClient } from '../../api'

export type ApiClient = ReturnType<typeof createApiClient>

const ApiClientContext = createContext<ApiClient | null>(null)

export interface ApiClientProviderProps {
  children: React.ReactNode
  /** Optional custom client for testing */
  client?: ApiClient
}

/**
 * Provider that creates and provides the API client.
 * Use the client prop to inject a mock client for testing.
 */
export function ApiClientProvider({ children, client }: ApiClientProviderProps) {
  const apiClient = useMemo(() => {
    return client ?? createApiClient()
  }, [client])

  return <ApiClientContext.Provider value={apiClient}>{children}</ApiClientContext.Provider>
}

/**
 * Hook to access the API client.
 * Must be used within an ApiClientProvider.
 */
export function useApiClient(): ApiClient {
  const client = useContext(ApiClientContext)
  if (!client) {
    throw new Error('useApiClient must be used within an ApiClientProvider')
  }
  return client
}

/**
 * Hook that returns the API client or null if not in a provider.
 * Useful for conditional usage or graceful degradation.
 */
export function useOptionalApiClient(): ApiClient | null {
  return useContext(ApiClientContext)
}
