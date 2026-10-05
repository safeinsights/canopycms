import path from 'node:path'

import { minimatch } from 'minimatch'

import type {
  PathPermission,
  DefaultPathAccess,
  PermissionLevel,
  PermissionTarget,
} from '../config'
import { isAdmin } from './helpers'
import type { CanopyUser } from '../user'
import type { PathPermissionResult } from './types'
import type { LogicalPath } from '../paths/types'

function normalize(p: LogicalPath): LogicalPath {
  const normalized = (p as string).split(path.sep).join('/')
  return normalized.replace(/^\.?\/*/, '') as LogicalPath
}

function matchesRule(rule: PathPermission, logicalPath: LogicalPath): boolean {
  return minimatch(logicalPath as string, rule.path, { dot: true })
}

function isAllowedByTarget(target: PermissionTarget, user: CanopyUser): boolean {
  const hasUserConstraint = !!target.allowedUsers?.length
  const hasGroupConstraint = !!target.allowedGroups?.length

  // A target with no constraints applies to everyone.
  if (!hasUserConstraint && !hasGroupConstraint) {
    return true
  }

  const matchesUser = hasUserConstraint && target.allowedUsers?.includes(user.userId)
  const matchesGroup =
    hasGroupConstraint && user.groups?.some((gid) => target.allowedGroups?.includes(gid))

  return Boolean(matchesUser || matchesGroup)
}

/**
 * Resolve `defaultPathAccess` to an 'allow'/'deny' verdict for one permission
 * level. String form applies to every level; object form looks up the level,
 * and an absent level resolves to 'deny' (fail-closed) so `{ read: 'allow' }`
 * cannot accidentally open edit/review.
 * @internal Exported for tests.
 */
export function resolveDefaultPathAccess(
  defaultAccess: DefaultPathAccess,
  level: PermissionLevel,
): 'allow' | 'deny' {
  if (typeof defaultAccess === 'string') return defaultAccess
  return defaultAccess[level] ?? 'deny'
}

/**
 * Evaluate access for a path against config-defined rules. First matching rule wins;
 * defaultAccess applies when none matches.
 *
 * Rule globs and the checked path are both LOGICAL paths: content-root-prefixed and
 * id-free, the space the Permission Manager writes rules in. An entry's logical path is
 * `<collection logical path>/<slug>` (`entryLogicalPath`), e.g. `content/blog/my-post`, never
 * its on-disk `content/blog.<id>/post.my-post.<id>.json`.
 * @internal Exported for tests.
 */
export function checkPathAccess({
  rules,
  logicalPath,
  user,
  defaultAccess,
  level,
}: {
  rules: PathPermission[]
  logicalPath: LogicalPath
  user: CanopyUser
  defaultAccess: DefaultPathAccess
  level: PermissionLevel
}): PathPermissionResult {
  const normalizedPath = normalize(logicalPath)

  // Only Admins bypass all path permissions
  if (isAdmin(user.groups)) {
    return { allowed: true, reason: 'admin' }
  }

  for (const rule of rules) {
    if (!matchesRule(rule, normalizedPath)) {
      continue
    }

    const target = rule[level]
    if (!target) {
      // A rule that defines nothing for this level does not decide it.
      continue
    }

    const allowed = isAllowedByTarget(target, user)
    return {
      allowed,
      matchedRule: rule,
      reason: allowed ? 'allowed_by_rule' : 'denied_by_rule',
    }
  }

  return {
    allowed: resolveDefaultPathAccess(defaultAccess, level) === 'allow',
    reason: 'no_rule_match',
  }
}

export function createCheckPathAccess(rules: PathPermission[], defaultAccess: DefaultPathAccess) {
  return (input: {
    logicalPath: LogicalPath
    user: CanopyUser
    level: PermissionLevel
  }): PathPermissionResult => checkPathAccess({ ...input, rules, defaultAccess })
}
