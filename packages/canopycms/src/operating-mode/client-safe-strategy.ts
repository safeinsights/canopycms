/**
 * Base strategy classes, safe in 'use client' React components: pure logic and
 * simple data, NO Node.js imports. client-unsafe-strategy.ts extends these to
 * add the Node.js surface.
 */

import type { OperatingMode, ClientSafeStrategy } from './types'

export class ProdClientSafeStrategy implements ClientSafeStrategy {
  readonly mode: OperatingMode = 'prod'

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

export class DevClientSafeStrategy implements ClientSafeStrategy {
  readonly mode: OperatingMode = 'dev'

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
    return false // No real GitHub in local dev mode
  }

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

const clientStrategyCache = new Map<OperatingMode, ClientSafeStrategy>()

/**
 * Memoized: one instance per mode for the process lifetime, so this is safe to
 * call inline — `clientOperatingStrategy(mode).supportsBranching()`.
 */
export function clientOperatingStrategy(mode: OperatingMode): ClientSafeStrategy {
  const cached = clientStrategyCache.get(mode)
  if (cached) return cached

  let strategy: ClientSafeStrategy
  switch (mode) {
    case 'prod':
      strategy = new ProdClientSafeStrategy()
      break
    case 'dev':
      strategy = new DevClientSafeStrategy()
      break
    default: {
      // Exhaustiveness check: adding a mode without a case fails to compile.
      const _exhaustive: never = mode
      throw new Error(`Unknown operating mode: ${_exhaustive}`)
    }
  }

  clientStrategyCache.set(mode, strategy)
  return strategy
}

/**
 * Mainly for testing.
 * @internal Exported for tests.
 */
export function clearClientStrategyCache(): void {
  clientStrategyCache.clear()
}
