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
 * Detect a build, where there is no request and no auth.
 *
 * Under Next.js this is `NEXT_PHASE === 'phase-production-build'`, which
 * `next build` sets itself: after compiling, and immediately before it creates
 * the static worker that collects page data and prerenders, whose processes
 * inherit it. So it is true in page modules, `generateStaticParams` and
 * prerendering, but NOT yet set when `next build` loads `next.config.*`, which
 * it does first. `next dev`, `next start` and the standalone server never set
 * it. Verified in Next 15.5.21 and 16.1.7, where `build/index.js` (in both
 * `dist/` and `dist/esm/`) holds the only assignment -- re-check on every Next
 * major.
 *
 * `CANOPY_BUILD_MODE=true` is the framework-neutral switch: for builds Next
 * does not drive, and for scripts run alongside one (the generated
 * `Dockerfile.cms` sets it in its builder stage, ahead of the build command).
 */
export const isBuildMode = (): boolean => {
  // Next.js build phase
  if (process.env.NEXT_PHASE === 'phase-production-build') return true

  // Generic build mode flag (can be set by any framework)
  if (process.env.CANOPY_BUILD_MODE === 'true') return true

  return false
}

/**
 * Is content read straight from the checkout, rather than from a branch
 * workspace?
 *
 * This decides WHERE content is read. `isDeployedStatic` and `isBuildMode`
 * used on their own decide WHO reads it (`STATIC_DEPLOY_USER`, no ACLs).
 *
 * True for a static deployment, and for every build in either mode and either
 * deployment type. A build reads the working tree at `process.cwd()` and
 * never touches git, `.canopy-dev` or a branch clone: CI builds exactly the
 * checked-out commit, and a local build reads what is on disk, uncommitted
 * files included. Editor saves not yet copied out of `.canopy-dev`
 * (`canopycms sync pull`) are not part of a build.
 */
export const readsFromCheckout = (config: { deployedAs?: string }): boolean => {
  return isDeployedStatic(config) || isBuildMode()
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
