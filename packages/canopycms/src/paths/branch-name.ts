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
 * `canopycms-settings-*` branch this deployment doesn't own, and
 * operating-mode/branch-namespace.ts refuses a branch namespace whose branches
 * could fall in it.
 *
 * The WHOLE prefix is reserved, not just this deployment's own settings branch:
 * two deployments can share one GitHub repo, and a content branch landing on
 * the other's settings-branch name silently corrupts that deployment's
 * permissions/groups once its worker treats the ref as an orphan settings
 * branch.
 */
export const RESERVED_SETTINGS_BRANCH_PREFIX = 'canopycms-settings-'

/**
 * Branch `name`'s short name: the part after `namespace` for a branch in it, the full name for
 * any other, and for one whose remainder holds a `/`. So a short name holding a `/` is always a
 * full name, which the editor's unlisted request segment (editor/branch-names.ts `unlistedSegment`)
 * relies on. The server rebuilds the ref from it (branch-param.ts's `resolveBranchParam`); the
 * editor is never told the namespace.
 */
export function branchShortName(name: string, namespace: string | null): string {
  if (namespace === null || !name.startsWith(namespace) || name.length === namespace.length) {
    return name
  }
  const rest = name.slice(namespace.length)
  return rest.includes('/') ? name : rest
}

/**
 * Whether `branchName` is a settings branch, never a content branch: the reserved prefix, or the
 * configured name (which need not carry it). Compared sanitized, the form git and disk use.
 */
export function isSettingsBranchName(branchName: string, settingsBranchName?: string): boolean {
  const sanitized = sanitizeBranchName(branchName)
  return (
    sanitized.startsWith(RESERVED_SETTINGS_BRANCH_PREFIX) ||
    (settingsBranchName !== undefined && sanitized === sanitizeBranchName(settingsBranchName))
  )
}
