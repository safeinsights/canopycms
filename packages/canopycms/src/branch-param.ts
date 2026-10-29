/**
 * The one way a branch named in a request, by a `/:branch` segment or `?branch=`, becomes its
 * workspace. A branch has three names: its ref (`canopycms/prod/spring`), which git and
 * branch.json's `name` hold; its key (`sanitizeBranchName(ref)`), the workspace directory and
 * registry key; and its short name (`spring`, `branchShortName`), which requests carry.
 */
import { loadBranchContext } from './branch-metadata'
import type { CanopyConfig } from './config'
import { operatingStrategy } from './operating-mode'
import { namesNoWorkspace } from './paths/branch'
import { branchShortName } from './paths/branch-name'
import type { BranchContext } from './types'
import { BaseBranchUnresolvedError, baseBranchOf } from './utils/base-branch'

export type BranchParamConfig = Pick<
  CanopyConfig,
  'mode' | 'defaultBaseBranch' | 'defaultActiveBranch' | 'branchNamespace' | 'deploymentName'
>

/**
 * The namespace this CMS creates branches in, or null when its template is invalid: creation
 * then refuses, and System health names why.
 */
function cmsBranchNamespace(config: BranchParamConfig): string | null {
  try {
    return operatingStrategy(config.mode).getBranchNamespace(config)
  } catch {
    return null
  }
}

/** The short name of the branch whose ref is `name`, under this CMS's namespace. */
export function shortNameOf(config: BranchParamConfig, name: string): string {
  return branchShortName(name, cmsBranchNamespace(config))
}

/**
 * The workspace `param` names, or null. In order:
 * 1. the base or configured active branch, exactly, so no namespace branch ever shadows it;
 * 2. the namespace branch whose short name is `param`, when its branch.json `name` is that ref;
 * 3. a branch outside the namespace by its full name, when its `name` is `param`. A namespace
 *    branch's full ref resolves here too.
 * Throws what loading throws for a name that can name no workspace (`namesNoWorkspace`).
 */
export async function resolveBranchParam(
  param: string,
  config: BranchParamConfig,
  options: { basePathOverride?: string } = {},
): Promise<BranchContext | null> {
  const load = (branchName: string) =>
    loadBranchContext({ branchName, mode: config.mode, basePathOverride: options.basePathOverride })

  let base: string | undefined
  try {
    base = baseBranchOf(config)
  } catch (err) {
    if (!(err instanceof BaseBranchUnresolvedError)) throw err
  }
  if (base !== undefined && (param === base || param === (config.defaultActiveBranch ?? base))) {
    return load(param)
  }

  const namespace = cmsBranchNamespace(config)
  if (namespace !== null) {
    const ref = `${namespace}${param}`
    // A ref past a filename's length can still leave `param` naming a branch outside it.
    const inNamespace = await load(ref).catch((err: unknown) => {
      if (namesNoWorkspace(err)) return null
      throw err
    })
    if (inNamespace?.branch.name === ref) return inNamespace
  }

  const outside = await load(param)
  return outside?.branch.name === param ? outside : null
}
