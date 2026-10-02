/**
 * Test utilities for authorization types: unsafe casts with NO validation,
 * for test files only. Production code uses parsePermissionPath().
 */

import type { PermissionPath, ContentAccessDeps } from './types'
import type { BranchContext } from '../types'
import type { CanopyUser } from '../user'
import {
  createCheckContentAccess,
  createContentAccessChecker,
  type ContentAccessChecker,
} from './content'

/** Test-only: cast a string to PermissionPath without validation. */
export const unsafeAsPermissionPath = (path: string): PermissionPath => path as PermissionPath

/**
 * Test-only: bind the single-call `checkContentAccess` and the batch
 * `createContentAccessChecker` to one shared deps object, the way `services.ts`
 * binds them, so tests can wire both into mock services.
 */
export const createTestContentAccess = (
  deps: ContentAccessDeps,
): {
  checkContentAccess: ReturnType<typeof createCheckContentAccess>
  createContentAccessChecker: (
    context: BranchContext,
    branchRoot: string,
    user: CanopyUser,
  ) => Promise<ContentAccessChecker>
} => ({
  checkContentAccess: createCheckContentAccess(deps),
  createContentAccessChecker: (context, branchRoot, user) =>
    createContentAccessChecker(deps, context, branchRoot, user),
})
