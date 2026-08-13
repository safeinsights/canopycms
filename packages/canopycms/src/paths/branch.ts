/**
 * Branch path resolution utilities.
 *
 * Handles resolving branch names to workspace directories.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import type { BranchContext } from '../types'
import { OperatingMode, operatingStrategy } from '../operating-mode'

export interface BranchPathOptions {
  mode: OperatingMode
  branchName: string
  basePathOverride?: string
}

export interface BranchPathResult {
  branchRoot: string
  baseRoot: string
  branchName: string
}

export class BranchPathError extends Error {}

// Moved to ./branch-name (dependency-free) so client-reachable modules can
// use it without dragging this file's node:fs / operating-mode imports into
// browser bundles. Imported for local use + re-exported for existing
// server-side importers.
import { sanitizeBranchName } from './branch-name'
export { sanitizeBranchName }

const resolveContentBranchesRoot = (mode: OperatingMode, override?: string): string => {
  return operatingStrategy(mode).getContentBranchesRoot(override)
}

/**
 * Resolve branch name to workspace paths.
 * Validates for path traversal attacks.
 */
export function resolveBranchPath(options: BranchPathOptions): BranchPathResult {
  if (options.branchName.includes('..')) {
    throw new BranchPathError('Branch name cannot contain traversal segments')
  }
  const safeBranch = sanitizeBranchName(options.branchName)
  const strategy = operatingStrategy(options.mode)
  const baseRoot = resolveContentBranchesRoot(options.mode, options.basePathOverride)
  const normalizedBase = path.resolve(baseRoot)
  const baseWithSep = normalizedBase.endsWith(path.sep)
    ? normalizedBase
    : `${normalizedBase}${path.sep}`
  const branchRoot = strategy.getContentBranchRoot(safeBranch, options.basePathOverride)

  const withinBase = (target: string) => {
    const resolved = path.resolve(target)
    return resolved === normalizedBase || resolved.startsWith(baseWithSep)
  }

  if (!withinBase(branchRoot)) {
    throw new BranchPathError('Branch path resolves outside the base root')
  }

  return { branchRoot, baseRoot: normalizedBase, branchName: safeBranch }
}

/**
 * Ensure the branch workspace directory exists.
 */
export async function ensureBranchRoot(options: BranchPathOptions): Promise<BranchPathResult> {
  const result = resolveBranchPath(options)
  await fs.mkdir(result.branchRoot, { recursive: true })
  return result
}

/**
 * Get the default base directory for branch workspaces.
 */
export function getDefaultBranchBase(mode: OperatingMode, override?: string): string {
  return resolveContentBranchesRoot(mode, override)
}

/**
 * Resolve branch paths from a branch context.
 */
export function resolveBranchPaths(
  branchContext: BranchContext,
  mode: OperatingMode,
  basePathOverride?: string,
): BranchPathResult {
  if (branchContext.branchRoot || branchContext.baseRoot) {
    const baseRoot = path.resolve(
      branchContext.baseRoot ?? resolveContentBranchesRoot(mode, basePathOverride),
    )
    const branchRoot = path.resolve(branchContext.branchRoot ?? baseRoot)
    return {
      branchRoot,
      baseRoot,
      branchName: sanitizeBranchName(branchContext.branch.name),
    }
  }

  return resolveBranchPath({
    mode,
    branchName: branchContext.branch.name,
    basePathOverride,
  })
}
