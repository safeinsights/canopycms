/**
 * Test utilities for authorization types.
 *
 * These are unsafe casts with NO validation. Import only from test files.
 * For production code, use parsePermissionPath() instead.
 *
 * @example
 * // In test files only:
 * import { unsafeAsPermissionPath } from '../authorization/test-utils'
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
 * Test-only: build the single-call `checkContentAccess` and the batch
 * `createContentAccessChecker` from one shared deps object, so tests can wire both
 * into mock services without duplicating deps. Mirrors how `services.ts` binds them.
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
