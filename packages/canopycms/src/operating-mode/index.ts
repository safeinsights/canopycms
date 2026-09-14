/**
 * Operating Mode Strategy Pattern - Public API
 *
 * Two-layer architecture:
 * 1. Client-safe strategies - safe for 'use client' React components (no Node.js imports)
 * 2. Client-unsafe strategies - full server-side functionality (uses fs, path, process)
 */

// Client-safe factory and strategy (safe for client bundles)
export { clientOperatingStrategy, clearClientStrategyCache } from './client-safe-strategy'

// Client-unsafe factory and strategy (server-side only)
export { operatingStrategy, clearStrategyCache } from './client-unsafe-strategy'

// Single resolution point for deploymentName (env > config > mode default) —
// server-only (reads process.env), used by the strategies' getSettingsBranchName.
export { resolveDeploymentName, isValidDeploymentName } from './deployment-name'

// Single resolution point for `mode` (env > config.mode) — isomorphic, applied
// inside validateCanopyConfig so every config-authoring path gets it.
export { resolveOperatingMode, SERVER_MODE_ENV_VAR, BROWSER_MODE_ENV_VAR } from './mode-env'

export type OperatingMode = 'prod' | 'dev'

export type { ClientSafeStrategy, ClientUnsafeStrategy, ResolveRemoteUrlOptions } from './types'
