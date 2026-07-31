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

/**
 * Prefix reserved for CanopyCMS settings branches (`canopycms-settings-{name}`,
 * see operating-mode/client-unsafe-strategy.ts's `getSettingsBranchName` and
 * operating-mode/deployment-name.ts's `resolveDeploymentName`). Exported from
 * this dependency-free module -- not constructed ad hoc at each call site --
 * so every consumer that needs to recognize the settings-branch namespace
 * agrees on the exact string: worker/cms-worker.ts's `pushSettingsBranches`
 * (never push a `canopycms-settings-*` branch this deployment doesn't own),
 * and api/branch.ts's `createBranchHandler` (reject a user-requested branch
 * whose SANITIZED name falls in this namespace).
 *
 * Two CanopyCMS deployments can share one GitHub repo, each with its own
 * settings branch under this prefix (`canopycms-settings-prod` vs
 * `canopycms-settings-staging`, say). A content-branch request that lands on
 * ANOTHER deployment's settings branch name would silently corrupt that
 * deployment's permissions/groups the next time its worker treats the ref as
 * an orphan settings branch -- so the whole prefix is reserved for branch
 * creation, not just this deployment's own settings branch name.
 */
export const RESERVED_SETTINGS_BRANCH_PREFIX = 'canopycms-settings-'
