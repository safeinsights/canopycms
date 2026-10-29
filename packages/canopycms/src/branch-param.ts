/**
 * The one way a branch named in a request, by a `/:branch` segment or `?branch=`, becomes its
 * workspace. A branch has three names: its ref (`canopycms/prod/spring`), which git and
 * branch.json's `name` hold; its key (`sanitizeBranchName(ref)`), the workspace directory and
 * registry key; and its short name (`spring`, `branchShortName`), which pull request links carry
 * and requests may carry in place of the ref.
 */
import { loadBranchContext } from './branch-metadata'
import type { CanopyConfig } from './config'
import { operatingStrategy } from './operating-mode'
import { namesNoWorkspace } from './paths/branch'
import { branchShortName } from './paths/branch-name'
import { exactBranchName, isExactBranchForm } from './paths/validation'
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

/** Whether `param` is the base or configured active branch, which resolve before any other. */
function namesBaseOrActive(param: string, config: BranchParamConfig): boolean {
  let base: string
  try {
    base = baseBranchOf(config)
  } catch (err) {
    if (err instanceof BaseBranchUnresolvedError) return false
    throw err
  }
  return param === base || param === (config.defaultActiveBranch ?? base)
}

/**
 * The name pull request links and messages give the branch whose ref is `name`: its short name
 * under this CMS's namespace, or the full ref when the short name is the base or active
 * branch's, which the resolver would answer instead.
 */
export function shortNameOf(config: BranchParamConfig, name: string): string {
  const short = branchShortName(name, cmsBranchNamespace(config))
  return short !== name && namesBaseOrActive(short, config) ? name : short
}

/**
 * The workspace `param` names, or null. A `param` in the exact form (`exactBranchSegment`,
 * `~canopycms~prod~spring`) names only the branch whose branch.json `name` it decodes to, and a
 * malformed one names none. Any other `param`, in order:
 * 1. the base or configured active branch, exactly, so no namespace branch ever shadows it;
 * 2. the namespace branch whose short name is `param`, when its branch.json `name` is that ref;
 * 3. a branch outside the namespace by its full name, when its `name` is `param`. A namespace
 *    branch's full ref resolves here too. A branch outside the namespace that step 2 shadows
 *    opens only by the exact form.
 * Throws what loading throws for a name that can name no workspace (`namesNoWorkspace`).
 */
export async function resolveBranchParam(
  param: string,
  config: BranchParamConfig,
  options: { basePathOverride?: string } = {},
): Promise<BranchContext | null> {
  const load = (branchName: string) =>
    loadBranchContext({ branchName, mode: config.mode, basePathOverride: options.basePathOverride })

  if (isExactBranchForm(param)) {
    const exact = exactBranchName(param)
    if (exact === null) return null
    const named = await load(exact)
    return named?.branch.name === exact ? named : null
  }

  if (namesBaseOrActive(param, config)) return load(param)

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
