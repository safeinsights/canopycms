/**
 * Operating mode strategies, in two layers: client-safe ones carry no Node.js
 * imports and are usable from 'use client' components; client-unsafe ones add
 * the server-side surface (fs, path, process) and must stay off the client.
 */

export { clientOperatingStrategy, clearClientStrategyCache } from './client-safe-strategy'

// Server-side only.
export { operatingStrategy, clearStrategyCache } from './client-unsafe-strategy'

// Single resolution point for deploymentName — server-only (reads process.env),
// used by the strategies' getSettingsBranchName.
export { resolveDeploymentName, isValidDeploymentName } from './deployment-name'

// Single resolution point for `mode` — isomorphic, applied inside
// validateCanopyConfig so every config-authoring path gets it.
export { resolveOperatingMode } from './mode-env'

export type OperatingMode = 'prod' | 'dev'

export type { ClientSafeStrategy, ClientUnsafeStrategy, ResolveRemoteUrlOptions } from './types'
