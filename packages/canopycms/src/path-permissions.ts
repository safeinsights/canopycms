import path from 'node:path'

import { minimatch } from 'minimatch'

import type { CanopyUserId } from './types'
import type { PathPermission, DefaultPathAccess } from './config'
import { isAdmin, isReviewer } from './reserved-groups'

export interface PathPermissionResult {
  allowed: boolean
  matchedRule?: PathPermission
  reason?: string
}

const normalize = (p: string): string => {
  const normalized = p.split(path.sep).join('/')
  return normalized.replace(/^\.?\/*/, '')
}

const matchesRule = (rule: PathPermission, relativePath: string): boolean =>
  minimatch(relativePath, rule.path, { dot: true })

const isAllowedByRule = (
  rule: PathPermission,
  userId: CanopyUserId,
  groupIds: string[] | undefined,
): boolean => {
  // managerOrAdminAllowed means only Reviewers (and Admins) can access
  if (rule.managerOrAdminAllowed) {
    return isReviewer(groupIds)
  }
  const hasUserConstraint = !!rule.allowedUsers?.length
  const hasGroupConstraint = !!rule.allowedGroups?.length
  const matchesUser = hasUserConstraint && rule.allowedUsers?.includes(userId)
  const matchesGroup =
    hasGroupConstraint && groupIds?.some((gid) => rule.allowedGroups?.includes(gid))

  if (!hasUserConstraint && !hasGroupConstraint) {
    return true
  }

  return Boolean(matchesUser || matchesGroup)
}

/**
 * Evaluate access for a relative path against config-defined rules.
 * Uses defaultAccess when no rule matches. First matching rule wins.
 */
export const checkPathAccess = ({
  rules,
  relativePath,
  userId,
  groupIds,
  defaultAccess = 'allow',
}: {
  rules: PathPermission[]
  relativePath: string
  userId: CanopyUserId
  groupIds?: string[]
  defaultAccess?: DefaultPathAccess
}): PathPermissionResult => {
  const normalizedPath = normalize(relativePath)
  // Only Admins bypass all path permissions (not Reviewers)
  if (isAdmin(groupIds)) {
    return { allowed: true, reason: 'admin' }
  }

  for (const rule of rules) {
    if (!matchesRule(rule, normalizedPath)) {
      continue
    }
    const allowed = isAllowedByRule(rule, userId, groupIds)
    return {
      allowed,
      matchedRule: rule,
      reason: allowed ? 'allowed_by_rule' : 'denied_by_rule',
    }
  }

  return { allowed: defaultAccess === 'allow', reason: 'no_rule_match' }
}

/**
 * Factory to bind rules and defaultAccess once.
 */
export const createCheckPathAccess = (
  rules: PathPermission[],
  defaultAccess: DefaultPathAccess = 'allow',
) => {
  return (
    input: Omit<Parameters<typeof checkPathAccess>[0], 'rules' | 'defaultAccess'>,
  ): PathPermissionResult => checkPathAccess({ ...input, rules, defaultAccess })
}
