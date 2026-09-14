/**
 * Client-Safe Operating Mode Strategy - Client Bundle Entry Point
 *
 * This module ONLY exports client-safe functionality with NO Node.js imports.
 * Safe to import in 'use client' React components.
 */

export { clientOperatingStrategy, clearClientStrategyCache } from './client-safe-strategy'
export type { ClientSafeStrategy } from './types'
export type { OperatingMode } from './types'
