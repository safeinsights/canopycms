/**
 * Branch-name sanitization, isolated in a dependency-free module (imports
 * nothing but types; same pattern as assets/asset-prefixes.ts).
 *
 * Client-reachable code (e.g. authorization/protected-branch.ts, which the
 * editor bundle reaches via api/guards.ts) MUST import `sanitizeBranchName`
 * from HERE, never from `paths/branch.ts` or the `paths` barrel: both pull
 * `node:fs` and the operating-mode strategies, and a `node:` import in that
 * graph breaks adopters' production `next build` of the editor bundle.
 * `pnpm lint:bundle` enforces it.
 */

import type { SanitizedBranchName } from './types'

/** Sanitize a branch name for use in filesystem paths. */
export function sanitizeBranchName(branchName: string): SanitizedBranchName {
  const replaced = branchName.replace(/[^a-zA-Z0-9._-]/g, '-')
  const squashed = replaced.replace(/-+/g, '-')
  const trimmedDots = squashed.replace(/^\.+/, '').replace(/(?<!\.)\.+$/, '')
  return (trimmedDots || 'branch') as SanitizedBranchName
}

/**
 * Prefix reserved for CanopyCMS settings branches (`canopycms-settings-{name}`;
 * built by operating-mode/client-unsafe-strategy.ts's `getSettingsBranchName`).
 * Exported from this dependency-free module -- not rebuilt ad hoc at each call
 * site -- so every consumer of the namespace agrees on the exact string:
 * worker/git-sync.ts's `pushSettingsBranches` never pushes a
 * `canopycms-settings-*` branch this deployment doesn't own, and api/branch.ts's
 * `createBranchHandler` rejects a user-requested branch whose SANITIZED name
 * falls in this namespace.
 *
 * The WHOLE prefix is reserved, not just this deployment's own settings branch:
 * two deployments can share one GitHub repo, and a content branch landing on
 * the other's settings-branch name silently corrupts that deployment's
 * permissions/groups once its worker treats the ref as an orphan settings
 * branch.
 */
export const RESERVED_SETTINGS_BRANCH_PREFIX = 'canopycms-settings-'

/**
 * Branch names that collide with a static top-level API route namespace.
 *
 * http/router.ts's `compareSpecificity` ranks a literal pattern segment above a
 * `:param`, so a branch named e.g. `admin` has its `/:branch/...` routes
 * shadowed by the static `/admin/...` ones -- and only partially, which is what
 * makes it confusing: bare `GET /admin` still reaches the branch handler, so the
 * branch looks half-alive while every nested route 404s or 403s.
 *
 * Listed rather than derived at runtime because api/validators.ts is imported
 * *by* the route modules, so importing the router here would cycle.
 * http/router.test.ts derives the same set from the live route table and asserts
 * it equals this constant, so a new top-level namespace fails that test until
 * this list is updated.
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
