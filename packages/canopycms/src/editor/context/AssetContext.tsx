'use client'

/**
 * Carries the prefix every editor-built asset URL is put behind - MediaLibrary thumbnails,
 * ImageField's preview and crop source, and the MDX editor's image previews. A context (rather
 * than a prop) because the MDX dialog is rendered deep inside MDXEditor's lazy-loaded internals
 * via `imagePlugin`'s `ImageDialog` param, with no prop channel of its own (the same reason
 * `EntryLinkContext` exists for the entry-link toolbar button).
 */

import React, { createContext, useContext, useMemo } from 'react'

import { joinUrlPrefix } from '../../utils/url-prefix'

/** The raw asset route (`api/assets.ts`'s `assetRawRoute`) under the default API base. */
const RAW_ASSET_ROUTE = '/api/canopycms/assets/raw'

/**
 * Where the editor loads asset bytes from: the authenticated raw route under `basePath`, never the
 * public `/assets` space. An editor asks for derivatives no build has seen (a fresh crop, a
 * thumbnail), which the public path need not serve, and the raw route computes them on demand.
 * Also handed to the live preview, through `PreviewFrame`.
 */
export function authenticatedAssetBase(basePath?: string): string {
  return joinUrlPrefix(basePath, RAW_ASSET_ROUTE)
}

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
