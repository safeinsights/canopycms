/**
 * Branch-name sanitization, isolated in a dependency-free module.
 *
 * Deliberately imports nothing but types: `paths/branch.ts` (the path
 * RESOLUTION module) pulls `node:fs` and the operating-mode strategies, so
 * isomorphic/client-reachable code (e.g. authorization/protected-branch.ts,
 * which the editor bundle reaches via api/guards.ts) must get
 * `sanitizeBranchName` from HERE, never from `paths/branch.ts` — a `node:`
 * import in that graph breaks adopters' production `next build` of the
 * editor bundle. Same pattern as assets/asset-prefixes.ts.
 */

import type { SanitizedBranchName } from './types'

/**
 * Sanitize a branch name for use in filesystem paths.
 * - Replaces invalid characters with hyphens
 * - Collapses multiple hyphens
 * - Trims leading/trailing dots
 */
export function sanitizeBranchName(branchName: string): SanitizedBranchName {
  const replaced = branchName.replace(/[^a-zA-Z0-9._-]/g, '-')
  const squashed = replaced.replace(/-+/g, '-')
  const trimmedDots = squashed.replace(/^\.+/, '').replace(/(?<!\.)\.+$/, '')
  return (trimmedDots || 'branch') as SanitizedBranchName
}
