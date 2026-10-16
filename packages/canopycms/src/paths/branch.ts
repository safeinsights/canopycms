/** Branch path resolution utilities. */

import path from 'node:path'

import type { BranchContext } from '../types'
import { OperatingMode, operatingStrategy } from '../operating-mode'
import { isNodeError } from '../utils/error'

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

/** @internal Exported for tests. */
export class BranchPathError extends Error {}

/**
 * True when a branch load failed because the name names no workspace: a traversal segment, a name
 * too long for a filename, or a path through a file (ENOTDIR), as `?branch=branches.json` gives.
 */
export function namesNoWorkspace(err: unknown): boolean {
  if (err instanceof BranchPathError) return true
  return isNodeError(err) && (err.code === 'ENAMETOOLONG' || err.code === 'ENOTDIR')
}

// Lives in ./branch-name (dependency-free); re-exported for server-side importers.
import { sanitizeBranchName, isSettingsBranchName } from './branch-name'
/** @internal Exported for tests. */
export { sanitizeBranchName }

const resolveContentBranchesRoot = (mode: OperatingMode, override?: string): string => {
  return operatingStrategy(mode).getContentBranchesRoot(override)
}

/** Resolve a branch name to workspace paths, rejecting traversal and settings-branch names. */
export function resolveBranchPath(options: BranchPathOptions): BranchPathResult {
  if (options.branchName.includes('..')) {
    throw new BranchPathError('Branch name cannot contain traversal segments')
  }
  if (isSettingsBranchName(options.branchName)) {
    throw new BranchPathError('Settings branches are not content branches')
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

export function getDefaultBranchBase(mode: OperatingMode, override?: string): string {
  return resolveContentBranchesRoot(mode, override)
}

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
