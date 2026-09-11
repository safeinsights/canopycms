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
 * agrees on the exact string: worker/git-sync.ts's `pushSettingsBranches`
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

/**
 * Branch names that collide with a static top-level API route namespace.
 *
 * http/router.ts's `compareSpecificity` ranks a literal pattern segment above a
 * `:param`, so a branch named e.g. `admin` has its `/:branch/...` routes
 * shadowed by the static `/admin/...` ones. The failure is a *partial* one,
 * which is what makes it confusing: bare `GET /admin` still reaches the branch
 * handler (there is no single-segment static `/admin` route), so the branch
 * looks half-alive while every nested route 404s or 403s.
 *
 * Lives in this dependency-free module for the same reason as
 * {@link RESERVED_SETTINGS_BRANCH_PREFIX}: api/validators.ts is imported *by*
 * the route modules, so nothing on the validation side can import the router to
 * derive this at runtime without a cycle. http/router.test.ts derives the same
 * set from the live route table and asserts it equals this constant, so adding
 * a new top-level namespace fails that test until this list is updated.
 */
export const RESERVED_ROUTE_BRANCH_NAMES: readonly string[] = [
  'admin',
  'assets',
  'branches',
  'groups',
  'permissions',
  'users',
  'whoami',
]
