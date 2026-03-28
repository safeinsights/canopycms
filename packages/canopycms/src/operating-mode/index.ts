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
 *   const contentRoot = strategy.getContentRoot()
 *   const branchesRoot = strategy.getContentBranchesRoot()
 *   const branchRoot = strategy.getContentBranchRoot('my-branch')
 *   const settingsRoot = strategy.getSettingsRoot()
 *   if (strategy.supportsBranching()) { ... } // can also use client-safe methods
 */

// Client-safe factory and strategy (safe for client bundles)
export { clientOperatingStrategy, clearClientStrategyCache } from './client-safe-strategy'

// Client-unsafe factory and strategy (server-side only)
export { operatingStrategy, clearStrategyCache } from './client-unsafe-strategy'

export type OperatingMode = 'prod' | 'dev'

// Type exports
export type { ClientSafeStrategy, ClientUnsafeStrategy, ResolveRemoteUrlOptions } from './types'
