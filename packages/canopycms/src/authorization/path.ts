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
import type { PhysicalPath } from '../paths/types'

function normalize(p: PhysicalPath): PhysicalPath {
  const normalized = (p as string).split(path.sep).join('/')
  return normalized.replace(/^\.?\/*/, '') as PhysicalPath
}

function matchesRule(rule: PathPermission, relativePath: PhysicalPath): boolean {
  return minimatch(relativePath as string, rule.path, { dot: true })
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
 */
export function resolveDefaultPathAccess(
  defaultAccess: DefaultPathAccess,
  level: PermissionLevel,
): 'allow' | 'deny' {
  if (typeof defaultAccess === 'string') return defaultAccess
  return defaultAccess[level] ?? 'deny'
}

/**
 * Evaluate access for a relative path against config-defined rules.
 * Uses defaultAccess when no rule matches. First matching rule wins.
 */
export function checkPathAccess({
  rules,
  relativePath,
  user,
  defaultAccess,
  level,
}: {
  rules: PathPermission[]
  relativePath: PhysicalPath
  user: CanopyUser
  defaultAccess: DefaultPathAccess
  level: PermissionLevel
}): PathPermissionResult {
  const normalizedPath = normalize(relativePath)

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
    relativePath: PhysicalPath
    user: CanopyUser
    level: PermissionLevel
  }): PathPermissionResult => checkPathAccess({ ...input, rules, defaultAccess })
}
