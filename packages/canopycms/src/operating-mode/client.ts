/**
 * Client-bundle entry point: exports ONLY client-safe functionality, with no
 * Node.js imports, so it is safe in 'use client' React components.
 */

export { clientOperatingStrategy, clearClientStrategyCache } from './client-safe-strategy'
export type { ClientSafeStrategy } from './types'
export type { OperatingMode } from './types'
