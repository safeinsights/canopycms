'use client'

/**
 * SWR configuration for the editor's data-fetching hooks (useBranchesData,
 * useEntriesData, useCommentsData). Centralizing config here means every
 * consumer gets the same dedup/cache behavior without repeating options.
 *
 * - revalidateOnFocus: false -- the editor isn't a live dashboard that needs
 *   to snap back to fresh data whenever the tab regains focus; a few
 *   seconds of staleness is harmless, and refetching on every alt-tab is
 *   just extra load against the branch clone.
 * - shouldRetryOnError: false -- matches the hooks' pre-SWR behavior, which
 *   surfaced a single failure (notification + console.error) rather than
 *   silently retrying in the background.
 * - provider: () => new Map() -- gives the editor its own cache instead of
 *   SWR's module-global one, so editor keys ("canopy:entries:main", ...) can
 *   never collide with an SWR cache the host app is running for its own data.
 *   `editor/hooks/__test__/test-utils.tsx` already mandates this for tests,
 *   with a comment about exactly that collision; production had been relying
 *   on the module global. Mounted once (CanopyEditor.tsx), so the cache spans
 *   the whole editor session.
 * - dedupingInterval: 2000 -- collapses the duplicate requests React Strict
 *   Mode's mount -> cleanup -> remount cycle produces (each hook's
 *   automatic on-mount fetch runs twice), plus any accidental
 *   near-simultaneous mounts of the same resource. See swr.md /
 *   editor-async-patterns.md (2026-07-24 decision) for the background.
 */

import React from 'react'
import { SWRConfig } from 'swr'

export interface SWRProviderProps {
  children: React.ReactNode
}

export function SWRProvider({ children }: SWRProviderProps) {
  return (
    <SWRConfig
      value={{
        provider: () => new Map(),
        revalidateOnFocus: false,
        shouldRetryOnError: false,
        dedupingInterval: 2000,
      }}
    >
      {children}
    </SWRConfig>
  )
}
