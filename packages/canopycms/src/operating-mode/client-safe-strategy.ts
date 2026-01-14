/**
 * Client-Safe Operating Mode Strategies
 *
 * Base strategy classes that are safe to import in 'use client' React components.
 * NO Node.js imports (fs, path, process, etc.) - only pure logic and simple data.
 *
 * These classes are extended by client-unsafe strategies to add Node.js functionality.
 */

import type { OperatingMode, ClientSafeStrategy } from './types'

// ============================================================================
// Production Mode - Client-Safe Strategy
// ============================================================================

export class ProdClientSafeStrategy implements ClientSafeStrategy {
  readonly mode: OperatingMode = 'prod'

  // UI Feature Flags
  supportsBranching(): boolean {
    return true
  }

  supportsStatusBadge(): boolean {
    return true
  }

  supportsComments(): boolean {
    return true
  }

  supportsPullRequests(): boolean {
    return true
  }

  // Simple Data
  getPermissionsFileName(): string {
    return 'permissions.json'
  }

  getGroupsFileName(): string {
    return 'groups.json'
  }

  shouldCommit(): boolean {
    return true
  }

  shouldPush(): boolean {
    return true
  }
}

// ============================================================================
// Local Production Simulation - Client-Safe Strategy
// ============================================================================

export class LocalProdSimClientSafeStrategy implements ClientSafeStrategy {
  readonly mode: OperatingMode = 'prod-sim'

  // UI Feature Flags
  supportsBranching(): boolean {
    return true
  }

  supportsStatusBadge(): boolean {
    return true
  }

  supportsComments(): boolean {
    return true
  }

  supportsPullRequests(): boolean {
    return false // No real GitHub in simulation
  }

  // Simple Data
  getPermissionsFileName(): string {
    return 'permissions.json'
  }

  getGroupsFileName(): string {
    return 'groups.json'
  }

  shouldCommit(): boolean {
    return true
  }

  shouldPush(): boolean {
    return true
  }
}

// ============================================================================
// Local Simple Mode - Client-Safe Strategy
// ============================================================================

export class LocalSimpleClientSafeStrategy implements ClientSafeStrategy {
  readonly mode: OperatingMode = 'dev'

  // UI Feature Flags
  supportsBranching(): boolean {
    return false
  }

  supportsStatusBadge(): boolean {
    return false
  }

  supportsComments(): boolean {
    return false
  }

  supportsPullRequests(): boolean {
    return false
  }

  // Simple Data
  getPermissionsFileName(): string {
    return 'permissions.json'
  }

  getGroupsFileName(): string {
    return 'groups.json'
  }

  shouldCommit(): boolean {
    return false
  }

  shouldPush(): boolean {
    return false
  }
}

// ============================================================================
// Factory with Memoization
// ============================================================================

const clientStrategyCache = new Map<OperatingMode, ClientSafeStrategy>()

/**
 * Get the client-safe strategy for an operating mode.
 *
 * Strategies are memoized - one instance per mode for the entire process lifetime.
 * Safe to call inline: clientOperatingStrategy(mode).supportsBranching()
 *
 * @param mode - The operating mode
 * @returns Client-safe strategy instance
 */
export function clientOperatingStrategy(mode: OperatingMode): ClientSafeStrategy {
  const cached = clientStrategyCache.get(mode)
  if (cached) return cached

  let strategy: ClientSafeStrategy
  switch (mode) {
    case 'prod':
      strategy = new ProdClientSafeStrategy()
      break
    case 'prod-sim':
      strategy = new LocalProdSimClientSafeStrategy()
      break
    case 'dev':
      strategy = new LocalSimpleClientSafeStrategy()
      break
    default:
      // Exhaustiveness check - TypeScript will error if a mode is not handled
      const _exhaustive: never = mode
      throw new Error(`Unknown operating mode: ${_exhaustive}`)
  }

  clientStrategyCache.set(mode, strategy)
  return strategy
}

/**
 * Clear the client strategy cache (mainly for testing)
 */
export function clearClientStrategyCache(): void {
  clientStrategyCache.clear()
}
