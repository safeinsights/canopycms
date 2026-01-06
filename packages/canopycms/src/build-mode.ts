import type { AuthenticatedUser } from './user'

/**
 * Detect if running in static build mode.
 * Framework-agnostic - checks common build environment variables.
 */
export const isBuildMode = (): boolean => {
  // Next.js build phase
  if (process.env.NEXT_PHASE === 'phase-production-build') return true

  // Generic build mode flag (can be set by any framework)
  if (process.env.CANOPY_BUILD_MODE === 'true') return true

  return false
}

/**
 * Special user for build-time content access.
 * Has Admin privileges to bypass all permission checks during static generation.
 */
export const BUILD_USER: AuthenticatedUser = Object.freeze({
  type: 'authenticated',
  userId: '__build__',
  groups: ['Admins'],
  email: 'build@canopycms',
  name: 'Build Process',
}) as AuthenticatedUser
