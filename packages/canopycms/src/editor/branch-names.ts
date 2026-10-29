/**
 * The names an editor sees one branch by. A listed branch has its full name (`name`, the ref
 * `canopycms/prod/spring`), which keys everything the editor stores, and a short name
 * (`shortName`, `spring`; a branch outside the namespace lists its full name), which the person
 * sees and, unless another branch's short name shadows it, the URL carries (`branchUrlName`).
 * Requests name a listed branch by the exact form instead (`requestSegments`).
 */
import type { BranchListItem } from '../api/branch'
// NOT branch or the '../paths' barrel: both pull node:fs into the browser bundle.
import { sanitizeBranchName } from '../paths/branch-name'
import { exactBranchName, exactBranchSegment, isExactBranchForm } from '../paths/validation'

type Named = Pick<BranchListItem, 'name' | 'shortName'>

/** What a person is shown for a branch. */
export function displayBranchName(branch: Named): string {
  return branch.shortName ?? branch.name
}

/**
 * The listed branch `name` opens, as the server resolves it (branch-param.ts): by the exact form
 * (`exactBranchSegment`) only the branch with that full name; else a namespace branch by its short
 * name, then any branch by its full name. The server's first step, the base or active branch
 * exactly, needs none here: while it applies, `shortNameOf` lists no namespace branch under
 * either's name, and when the base cannot be resolved the server skips it too. A branch outside the
 * namespace lists its full name as its short name, so only a namespace branch matches by short name.
 */
function resolveExactly<B extends Named>(branches: readonly B[], name: string): B | undefined {
  if (isExactBranchForm(name)) {
    const exact = exactBranchName(name)
    return exact === null ? undefined : branches.find((b) => b.name === exact)
  }
  return (
    branches.find((b) => b.shortName === name && b.name !== name) ??
    branches.find((b) => b.name === name)
  )
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
): B | undefined {
  const exact = resolveExactly(branches, name)
  if (exact) return exact
  const sanitized = branches.find((b) => b.name === sanitizeBranchName(name))
  return sanitized && resolveExactly(branches, sanitized.name) === sanitized ? sanitized : undefined
}

/**
 * The `?branch=` value for `branch`: its short name when that opens the same branch, else its full
 * name when that does, else the exact form. Only the exact form opens a
 * branch outside the namespace whose name a namespace branch's short name takes.
 */
export function branchUrlName<B extends Named>(branches: readonly B[], branch: B): string {
  const short = displayBranchName(branch)
  if (resolveExactly(branches, short) === branch) return short
  if (resolveExactly(branches, branch.name) === branch) return branch.name
  return exactBranchSegment(branch.name)
}

/**
 * The `/:branch` segment requests name each listed branch by, keyed by full name: the exact form,
 * which the server resolves to that branch alone. Any other form it resolves again on every
 * request, so a dev active-branch change (`git checkout -b spring`) or a branch hidden from the
 * requester could put a different branch behind the same short name.
 */
export function requestSegments<B extends Named>(branches: readonly B[]): Map<string, string> {
  return new Map(branches.map((b) => [b.name, exactBranchSegment(b.name)]))
}

/**
 * The `/:branch` segment of a name no listed branch maps: the exact form when it holds a `/`, which
 * no short name does, so no path carries `%2F`; else the name as given, which a short name needs.
 */
export function unlistedSegment(name: string): string {
  return name.includes('/') ? exactBranchSegment(name) : name
}

/**
 * A name the editor resolves (`resolveListedBranch`) to `branch`, for an action on its card: its
 * full name, else its `branchUrlName` when another branch's short name shadows the full name.
 */
export function branchAddress<B extends Named>(branches: readonly B[], branch: B): string {
  return resolveExactly(branches, branch.name) === branch
    ? branch.name
    : branchUrlName(branches, branch)
}
