import type { AuthenticatedUser } from './user'

/**
 * Check if this deployment is static (no request context, no auth).
 * When true: STATIC_DEPLOY_USER is used, permissions are skipped.
 * All content is assumed publicly readable.
 */
export const isDeployedStatic = (config: { deployedAs?: string }): boolean => {
  return config.deployedAs === 'static'
}

/**
 * Safety net: detect build phase where auth is unavailable.
 * Covers edge cases like getCanopy() called from generateStaticParams
 * in server deployments. For static deployments, isDeployedStatic()
 * is the primary check.
 */
export const isBuildMode = (): boolean => {
  // Next.js build phase
  if (process.env.NEXT_PHASE === 'phase-production-build') return true

  // Generic build mode flag (can be set by any framework)
  if (process.env.CANOPY_BUILD_MODE === 'true') return true

  return false
}

/**
 * Synthetic user with full access for static deployments and build phase.
 * Has Admin privileges — all content is readable, permissions are skipped.
 */
export const STATIC_DEPLOY_USER: AuthenticatedUser = Object.freeze({
  type: 'authenticated',
  userId: '__static_deploy__',
  groups: ['Admins'],
  email: 'static-deploy@canopycms',
  name: 'Static Deploy',
}) as AuthenticatedUser
