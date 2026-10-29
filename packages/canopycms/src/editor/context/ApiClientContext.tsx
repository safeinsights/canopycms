'use client'

/**
 * Provides the API client via context-based dependency injection rather than
 * a module-global singleton, so tests can inject a mock client through the
 * provider instead of resetting global state between tests.
 */

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { createApiClient } from '../../api'
import { joinUrlPrefix } from '../../utils/url-prefix'
import type { OperatingMode } from '../../operating-mode/types'

export type ApiClient = ReturnType<typeof createApiClient>

const ApiClientContext = createContext<ApiClient | null>(null)

/** Fan-out for one of the client's notifications (`onUnauthorized`, `onEditorModeMismatch`). */
interface ClientSignal {
  emit: () => void
  subscribe: (listener: () => void) => () => void
}

function createClientSignal(): ClientSignal {
  const listeners = new Set<() => void>()
  return {
    emit: () => {
      for (const listener of [...listeners]) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

type BranchSegments = ReadonlyMap<string, string>

/** The branch-name to `/:branch`-segment lookup the provider's client reads, replaced as listings arrive. */
function createSegmentTable() {
  let segments: BranchSegments = new Map()
  return {
    lookup: (branch: string): string => segments.get(branch) ?? branch,
    replace: (next: BranchSegments): void => {
      segments = next
    },
  }
}

const BranchSegmentsContext = createContext<((segments: BranchSegments) => void) | null>(null)

const UnauthorizedSignalContext = createContext<ClientSignal | null>(null)
const EditorModeMismatchSignalContext = createContext<ClientSignal | null>(null)

export interface ApiClientProviderProps {
  children: React.ReactNode
  /** Optional custom client for testing */
  client?: ApiClient
  /**
   * Deployment prefix the host app is served under (`CanopyClientConfig.basePath`, e.g.
   * `/preview-123`). Joined onto the default `/api/canopycms` base via `joinUrlPrefix` so every
   * request the editor makes lands on the actual route instead of the un-prefixed root. Ignored
   * when `client` is supplied directly. Unset/empty is a no-op (same as today).
   */
  basePath?: string
  /** The mode this bundle was built for (`CanopyClientConfig.mode`); see `ApiClientOptions.editorMode`. */
  editorMode?: OperatingMode
}

/**
 * Provider that creates and provides the API client.
 * Use the client prop to inject a mock client for testing.
 */
export function ApiClientProvider({
  children,
  client,
  basePath,
  editorMode,
}: ApiClientProviderProps) {
  const [unauthorized] = useState(createClientSignal)
  const [modeMismatch] = useState(createClientSignal)
  // Memoized on identity, not just for cost: several consumers now list the client in their
  // effect deps (useUserContext, useReferenceResolution, ReferenceField), so a fresh client each
  // render would turn those one-shot fetches into a loop. A caller injecting an inline
  // `client={createApiClient()}` would reintroduce exactly that.
  //
  // Only a client built HERE reports to `useOnUnauthorized` and `useOnEditorModeMismatch`; an
  // injected `client` is used as-is, so its 401s and mode mismatches reach the auth gate only
  // through the gate's own whoami result.
  const [segmentTable] = useState(createSegmentTable)
  const apiClient = useMemo(() => {
    return (
      client ??
      createApiClient({
        baseUrl: joinUrlPrefix(basePath, '/api/canopycms'),
        onUnauthorized: unauthorized.emit,
        editorMode,
        onEditorModeMismatch: modeMismatch.emit,
        branchSegment: segmentTable.lookup,
      })
    )
  }, [client, basePath, editorMode, unauthorized, modeMismatch, segmentTable])

  return (
    <UnauthorizedSignalContext.Provider value={unauthorized}>
      <EditorModeMismatchSignalContext.Provider value={modeMismatch}>
        <BranchSegmentsContext.Provider value={segmentTable.replace}>
          <ApiClientContext.Provider value={apiClient}>{children}</ApiClientContext.Provider>
        </BranchSegmentsContext.Provider>
      </EditorModeMismatchSignalContext.Provider>
    </UnauthorizedSignalContext.Provider>
  )
}

/**
 * Subscribe to every unauthenticated response (`ApiClientOptions.onUnauthorized`) the provider's
 * client receives, from any request. `listener` should be
 * stable (e.g. from `useCallback`): a new function re-subscribes. No-op outside a provider.
 */
export function useOnUnauthorized(listener: () => void): void {
  const signal = useContext(UnauthorizedSignalContext)
  useEffect(() => signal?.subscribe(listener), [signal, listener])
}

/** As {@link useOnUnauthorized}, for responses refusing the editor's mode (`EDITOR_MODE_MISMATCH`). */
export function useOnEditorModeMismatch(listener: () => void): void {
  const signal = useContext(EditorModeMismatchSignalContext)
  useEffect(() => signal?.subscribe(listener), [signal, listener])
}

/**
 * Tells the provider's own client the `/:branch` segment each listed branch's requests carry
 * (name to segment); a name not in `segments` goes as given. Set during render, not in an effect:
 * a data hook fetches in a layout effect, before any effect here would run. No-op outside a
 * provider, and with an injected `client`, which keeps its own paths.
 */
export function useBranchSegments(segments: BranchSegments): void {
  const set = useContext(BranchSegmentsContext)
  set?.(segments)
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
