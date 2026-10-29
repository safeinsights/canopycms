/**
 * The names an editor sees one branch by. A listed branch has its full name (`name`, the ref
 * `canopycms/prod/spring`), which keys everything the editor stores, and a short name
 * (`shortName`, `spring`; a branch outside the namespace lists its full name), which the person
 * sees, the URL carries and requests send.
 */
import type { BranchListItem } from '../api/branch'
// branch-name, NOT branch or the '../paths' barrel: both pull node:fs into the browser bundle.
import { sanitizeBranchName } from '../paths/branch-name'

type Named = Pick<BranchListItem, 'name' | 'shortName'>

/** What a person is shown for a branch. */
export function displayBranchName(branch: Named): string {
  return branch.shortName ?? branch.name
}

/**
 * The listed branch `name` opens, in the order the server resolves a `?branch=`: the active branch
 * (`defaultBranch`) by its full name, then a namespace branch by its short name, then any branch
 * by its full name. The server lists no namespace branch under the base's or active branch's name
 * as its short name (`shortNameOf`), so the base needs no step of its own, and a branch outside
 * the namespace lists its full name as its short name, so only a namespace branch matches the
 * second.
 */
function resolveExactly<B extends Named>(
  branches: readonly B[],
  name: string,
  defaultBranch?: string,
): B | undefined {
  const byName = branches.find((b) => b.name === name)
  if (byName && name === defaultBranch) return byName
  return branches.find((b) => b.shortName === name && b.name !== name) ?? byName
}

/**
 * The listed branch `name` opens: `resolveExactly`'s answer, else the branch whose full name is
 * `name` sanitized, which catches a bookmark carrying a name's raw form ("feature/x" for the
 * persisted "feature-x"). A sanitized match counts only when its own name resolves back to it:
 * the server refuses the raw form, and a shadowed branch would open a different one.
 */
export function resolveListedBranch<B extends Named>(
  branches: readonly B[],
  name: string,
  defaultBranch?: string,
): B | undefined {
  const exact = resolveExactly(branches, name, defaultBranch)
  if (exact) return exact
  const sanitized = branches.find((b) => b.name === sanitizeBranchName(name))
  return sanitized && resolveExactly(branches, sanitized.name, defaultBranch) === sanitized
    ? sanitized
    : undefined
}

/**
 * The `?branch=` value for `branch`: its short name when that opens the same branch, else its
 * full name, so a URL never opens a different branch than the one shown.
 */
export function branchUrlName<B extends Named>(
  branches: readonly B[],
  branch: B,
  defaultBranch?: string,
): string {
  const short = displayBranchName(branch)
  return resolveExactly(branches, short, defaultBranch) === branch ? short : branch.name
}
