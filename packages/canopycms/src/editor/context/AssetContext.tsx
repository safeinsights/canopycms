'use client'

/**
 * Asset Context
 *
 * Carries `media.publicBaseUrl` (see CanopyClientConfig.assetBaseUrl) down to
 * every asset-URL-building component - MediaLibrary, ImageField, and the MDX
 * image dialog. A context (rather than a prop) because the MDX dialog is
 * rendered deep inside MDXEditor's lazy-loaded internals via `imagePlugin`'s
 * `ImageDialog` param, with no prop channel of its own (the same reason
 * `EntryLinkContext` exists for the entry-link toolbar button). Unlike
 * `ApiClientContext`, reading this without a provider is safe and intentional:
 * no provider means root-relative URLs, which is the correct default for the
 * common case (editor and site share an origin).
 */

import React, { createContext, useContext, useMemo } from 'react'

export interface AssetContextValue {
  /** Prefixed onto every asset URL the editor builds. `undefined` (no provider, or no `media.publicBaseUrl` configured) means root-relative - same-origin dev/prod-today behavior. */
  baseUrl?: string
}

const AssetContext = createContext<AssetContextValue>({})

export interface AssetContextProviderProps extends AssetContextValue {
  children: React.ReactNode
  /**
   * `CanopyClientConfig.basePath` - the deployment prefix the host app is served under. Used only
   * when `baseUrl` is unset.
   */
  basePath?: string
}

/**
 * `baseUrl` (`media.publicBaseUrl`) wins; `basePath` is the fallback.
 *
 * They are ALTERNATIVES, never composed: whichever is used names where `/assets` is mounted, in
 * full, and a deployment `basePath` cannot apply on top of it. Where the two differ is topology,
 * not precedence - see the asset-mount table in the README.
 *
 * WHY THE FALLBACK EXISTS, AND WHY THAT REASON IS NOW GONE. It was added because
 * `publicBaseUrl` was validated absolute-only (`z.string().url()`) and so could not express a
 * bare path, leaving the editor's thumbnails, previews and crop images root-relative — and 404 —
 * on a basePath deployment where Next serves `/assets`. That constraint was lifted when
 * `publicBaseUrl` moved to `assetMountUrlSchema`, which accepts a site-relative path: an adopter
 * can now simply set `publicBaseUrl: '/preview-123'`. The fallback is kept only so that existing
 * basePath deployments do not break on upgrade, which makes removing it a deliberate decision
 * rather than a cleanup - it is option 1 of
 * `.claude/future-tasks/editor-asset-mount-topology.md`, still open.
 *
 * KNOWN LIMITATION: the fallback assumes that topology, and consults none. On a CloudFront/CDK
 * deployment a basePath does NOT move the asset space (behaviors are anchored at the distribution
 * root), so prefixing is wrong there — the requests still resolve, because `withCanopy`'s
 * auto-prefixed `/assets/:path*` rewrite catches them and serves through the CMS Lambda, but they
 * bypass the CDN cache and the dedicated transform Lambda. The workaround is real though not
 * obvious: set `media.publicBaseUrl` to the distribution origin, which takes precedence here.
 * Tracked in `.claude/future-tasks/editor-asset-mount-topology.md`.
 */
export function AssetContextProvider({ baseUrl, basePath, children }: AssetContextProviderProps) {
  const resolved = baseUrl ?? basePath
  const value = useMemo<AssetContextValue>(() => ({ baseUrl: resolved }), [resolved])
  return <AssetContext.Provider value={value}>{children}</AssetContext.Provider>
}

/** Safe to call outside a provider - returns `{ baseUrl: undefined }` (root-relative URLs). */
export function useAssetContext(): AssetContextValue {
  return useContext(AssetContext)
}
