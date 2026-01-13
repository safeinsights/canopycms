import fs from 'node:fs/promises'
import path from 'node:path'

import type { BranchContext } from './types'
import { operatingStrategy } from './operating-mode'

export type OperatingMode = 'prod' | 'local-prod-sim' | 'local-simple'

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

const sanitizeBranchName = (branchName: string): string => {
  const replaced = branchName.replace(/[^a-zA-Z0-9._-]/g, '-')
  const squashed = replaced.replace(/-+/g, '-')
  const trimmedDots = squashed.replace(/^\.+/, '').replace(/\.+$/, '')
  return trimmedDots || 'branch'
}

const resolveBaseRoot = (mode: OperatingMode, override?: string): string => {
  return operatingStrategy(mode).getBaseRoot(override)
}

export const resolveBranchPath = (options: BranchPathOptions): BranchPathResult => {
  if (options.branchName.includes('..')) {
    throw new BranchPathError('Branch name cannot contain traversal segments')
  }
  const safeBranch = sanitizeBranchName(options.branchName)
  const baseRoot = resolveBaseRoot(options.mode, options.basePathOverride)
  const normalizedBase = path.resolve(baseRoot)
  const baseWithSep = normalizedBase.endsWith(path.sep) ? normalizedBase : `${normalizedBase}${path.sep}`
  const branchRoot = operatingStrategy(options.mode).getBranchRoot(normalizedBase, safeBranch)

  const withinBase = (target: string) => {
    const resolved = path.resolve(target)
    return resolved === normalizedBase || resolved.startsWith(baseWithSep)
  }

  if (!withinBase(branchRoot)) {
    throw new BranchPathError('Branch path resolves outside the base root')
  }

  return { branchRoot, baseRoot: normalizedBase, branchName: safeBranch }
}

export const ensureBranchRoot = async (options: BranchPathOptions): Promise<BranchPathResult> => {
  const result = resolveBranchPath(options)
  await fs.mkdir(result.branchRoot, { recursive: true })
  return result
}

export const getDefaultBranchBase = (mode: OperatingMode, override?: string): string =>
  resolveBaseRoot(mode, override)

export const resolveBranchPaths = (
  branchContext: BranchContext,
  mode: OperatingMode,
  basePathOverride?: string
): BranchPathResult => {
  if (branchContext.branchRoot || branchContext.baseRoot) {
    const baseRoot = path.resolve(branchContext.baseRoot ?? resolveBaseRoot(mode, basePathOverride))
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

export { sanitizeBranchName }
