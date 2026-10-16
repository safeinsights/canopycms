'use client'

/**
 * Carries the prefix every editor-built asset URL is put behind - MediaLibrary thumbnails,
 * ImageField's preview and crop source, and the MDX editor's image previews. A context (rather
 * than a prop) because the MDX dialog is rendered deep inside MDXEditor's lazy-loaded internals
 * via `imagePlugin`'s `ImageDialog` param, with no prop channel of its own (the same reason
 * `EntryLinkContext` exists for the entry-link toolbar button).
 */

import React, { createContext, useContext, useMemo } from 'react'

import { authenticatedAssetBase } from '../raw-asset-base'

export { authenticatedAssetBase }

export interface AssetContextValue {
  /** The `baseUrl` to pass to `assetUrl` for every asset URL the editor renders. */
  baseUrl: string
}

/** No provider means no `basePath`: the API is mounted at the origin root. */
const AssetContext = createContext<AssetContextValue>({ baseUrl: authenticatedAssetBase() })

export interface AssetContextProviderProps {
  children: React.ReactNode
  /** `CanopyClientConfig.basePath` - the deployment prefix the host app is served under. */
  basePath?: string
}

export function AssetContextProvider({ basePath, children }: AssetContextProviderProps) {
  const value = useMemo<AssetContextValue>(
    () => ({ baseUrl: authenticatedAssetBase(basePath) }),
    [basePath],
  )
  return <AssetContext.Provider value={value}>{children}</AssetContext.Provider>
}

/** Safe to call outside a provider - see the context's default. */
export function useAssetContext(): AssetContextValue {
  return useContext(AssetContext)
}
