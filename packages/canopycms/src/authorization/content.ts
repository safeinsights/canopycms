/**
 * Content access authorization
 *
 * This is the main entry point for authorization checks. It combines
 * branch-level and path-level access checks into a single API.
 */

import type { BranchContext } from '../types'
import type { PermissionLevel } from '../config'
import type { CanopyUser } from '../user'
import { operatingStrategy } from '../operating-mode'
import { createCheckPathAccess } from './path'
import type { ContentAccessResult, ContentAccessDeps } from './types'
import type { PhysicalPath } from '../paths/types'

/**
 * A bound content-access checker: evaluates a single path/level synchronously
 * against permissions that were already loaded when the checker was created.
 */
export type ContentAccessChecker = (
  relativePath: PhysicalPath,
  level: PermissionLevel,
) => ContentAccessResult

/**
 * Create a content-access checker that resolves the request-constant work once
 * (branch access, the settings/permissions root, and the path-permission rules)
 * and returns a synchronous per-path checker.
 *
 * Branch access, the resolved permissions root, and the loaded rules are identical
 * for a fixed `(context, branchRoot, user)`, so hoisting them out of the per-path
 * check avoids re-reading the permissions file (and, in modes with a separate
 * settings branch, re-ensuring the settings workspace) for every entry. This is
 * the batch primitive used by listing endpoints that check many paths per request.
 */
export async function createContentAccessChecker(
  deps: ContentAccessDeps,
  context: BranchContext,
  branchRoot: string,
  user: CanopyUser,
): Promise<ContentAccessChecker> {
  const branch = deps.checkBranchAccess(context, user)

  let permissionsRoot = branchRoot
  const mode = deps.mode
  const strategy = operatingStrategy(mode)

  if (strategy.usesSeparateSettingsBranch()) {
    if (!deps.getSettingsBranchRoot) {
      throw new Error(
        'getSettingsBranchRoot is required for modes that use separate settings branch',
      )
    }
    // getSettingsBranchRoot must throw if it cannot load the settings branch
    // This ensures we never fall back to reading permissions from the current branch
    permissionsRoot = await deps.getSettingsBranchRoot()
  }

  const rules = await deps.loadPathPermissions(permissionsRoot, deps.mode)
  const pathChecker = createCheckPathAccess(rules, deps.defaultPathAccess)

  return (relativePath, level) => {
    const path = pathChecker({
      relativePath,
      user,
      level,
    })

    return {
      allowed: branch.allowed && path.allowed,
      branch,
      path,
    }
  }
}

/**
 * Check content access by evaluating both branch and path permissions.
 * Path permissions are loaded dynamically from the branch root.
 */
export async function checkContentAccess(
  deps: ContentAccessDeps,
  context: BranchContext,
  branchRoot: string,
  relativePath: PhysicalPath,
  user: CanopyUser,
  level: PermissionLevel,
): Promise<ContentAccessResult> {
  const check = await createContentAccessChecker(deps, context, branchRoot, user)
  return check(relativePath, level)
}

export function createCheckContentAccess(deps: ContentAccessDeps) {
  return (
    context: BranchContext,
    branchRoot: string,
    relativePath: PhysicalPath,
    user: CanopyUser,
    level: PermissionLevel,
  ): Promise<ContentAccessResult> =>
    checkContentAccess(deps, context, branchRoot, relativePath, user, level)
}
