import fs from 'node:fs/promises'
import path from 'node:path'

import type { BranchState } from './types'

export type BranchMode = 'prod' | 'local-prod-sim' | 'local-simple'

export interface BranchPathOptions {
  mode: BranchMode
  branchName: string
  basePathOverride?: string
}

export interface BranchPathResult {
  branchRoot: string
  baseRoot: string
  metadataRoot: string
  branchName: string
}

export class BranchPathError extends Error {}

const DEFAULT_PROD_BASE = '/mnt/efs/site'

const sanitizeBranchName = (branchName: string): string => {
  const replaced = branchName.replace(/[^a-zA-Z0-9._-]/g, '-')
  const squashed = replaced.replace(/-+/g, '-')
  const trimmedDots = squashed.replace(/^\.+/, '').replace(/\.+$/, '')
  return trimmedDots || 'branch'
}

const resolveBaseRoot = (mode: BranchMode, override?: string): string => {
  if (override) return path.resolve(override)
  if (mode === 'prod') {
    const envBase = process.env.CANOPYCMS_BRANCH_ROOT
    return path.resolve(envBase || DEFAULT_PROD_BASE)
  }
  if (mode === 'local-prod-sim') {
    return path.resolve(process.cwd(), '.canopycms/branches')
  }
  return path.resolve(process.cwd()) // TODO this may not always be the same?
}

export const resolveBranchPath = (options: BranchPathOptions): BranchPathResult => {
  if (options.branchName.includes('..')) {
    throw new BranchPathError('Branch name cannot contain traversal segments')
  }
  const safeBranch = sanitizeBranchName(options.branchName)
  const baseRoot = resolveBaseRoot(options.mode, options.basePathOverride)
  const normalizedBase = path.resolve(baseRoot)
  const baseWithSep = normalizedBase.endsWith(path.sep)
    ? normalizedBase
    : `${normalizedBase}${path.sep}`
  const branchRoot =
    options.mode === 'local-simple' ? normalizedBase : path.resolve(normalizedBase, safeBranch)
  const metadataRoot = branchRoot

  const withinBase = (target: string) => {
    const resolved = path.resolve(target)
    return resolved === normalizedBase || resolved.startsWith(baseWithSep)
  }

  if (!withinBase(branchRoot) || !withinBase(metadataRoot)) {
    throw new BranchPathError('Branch path resolves outside the base root')
  }

  return { branchRoot, baseRoot: normalizedBase, metadataRoot, branchName: safeBranch }
}

export const ensureBranchRoot = async (options: BranchPathOptions): Promise<BranchPathResult> => {
  const result = resolveBranchPath(options)
  await fs.mkdir(result.branchRoot, { recursive: true })
  if (result.metadataRoot && result.metadataRoot !== result.branchRoot) {
    await fs.mkdir(result.metadataRoot, { recursive: true })
  }
  return result
}

export const getDefaultBranchBase = (mode: BranchMode, override?: string): string =>
  resolveBaseRoot(mode, override)

export const resolveBranchWorkspace = (
  branchState: BranchState,
  mode: BranchMode,
  basePathOverride?: string,
): BranchPathResult => {
  if (branchState.workspaceRoot || branchState.metadataRoot || branchState.baseRoot) {
    const baseRoot = path.resolve(branchState.baseRoot ?? resolveBaseRoot(mode, basePathOverride))
    const branchRoot = path.resolve(branchState.workspaceRoot ?? baseRoot)
    const metadataRoot = path.resolve(branchState.metadataRoot ?? branchRoot)
    return {
      branchRoot,
      metadataRoot,
      baseRoot,
      branchName: sanitizeBranchName(branchState.branch.name),
    }
  }

  return resolveBranchPath({
    mode,
    branchName: branchState.branch.name,
    basePathOverride,
  })
}

export { sanitizeBranchName }
