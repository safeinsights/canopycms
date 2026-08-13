/**
 * Operating Mode Strategy Pattern - Public API
 *
 * Two-layer architecture:
 * 1. Client-safe strategies - safe for 'use client' React components (no Node.js imports)
 * 2. Client-unsafe strategies - full server-side functionality (uses fs, path, process)
 *
 * Usage:
 *
 * Client components:
 *   import { clientOperatingStrategy } from '@/operating-mode'
 *   const strategy = clientOperatingStrategy(mode)
 *   if (strategy.supportsBranching()) { ... }
 *
 * Server code:
 *   import { operatingStrategy } from '@/operating-mode'
 *   const strategy = operatingStrategy(mode)
 *   // contentRoot is REQUIRED: pass config.contentRoot (falling back to 'content'
 *   // at the call site), never a bare call — see getContentRoot's doc comment in
 *   // types.ts for why a default here would silently disarm a caller.
 *   const contentRoot = strategy.getContentRoot(config.contentRoot ?? 'content')
 *   const branchesRoot = strategy.getContentBranchesRoot()
 *   const branchRoot = strategy.getContentBranchRoot('my-branch')
 *   const settingsRoot = strategy.getSettingsRoot()
 *   if (strategy.supportsBranching()) { ... } // can also use client-safe methods
 */

// Client-safe factory and strategy (safe for client bundles)
export { clientOperatingStrategy, clearClientStrategyCache } from './client-safe-strategy'

// Client-unsafe factory and strategy (server-side only)
export { operatingStrategy, clearStrategyCache } from './client-unsafe-strategy'

// Single resolution point for deploymentName (env > config > mode default) —
// server-only (reads process.env), used by the strategies' getSettingsBranchName.
export { resolveDeploymentName } from './deployment-name'

export type OperatingMode = 'prod' | 'dev'

// Type exports
export type { ClientSafeStrategy, ClientUnsafeStrategy, ResolveRemoteUrlOptions } from './types'
