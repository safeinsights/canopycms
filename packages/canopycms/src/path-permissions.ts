import path from 'node:path'

import { minimatch } from 'minimatch'

import type { CanopyUserId, Role } from './types'
import type { CanopyConfig, PathPermission } from './config'

export interface PathPermissionResult {
  allowed: boolean
  matchedRule?: PathPermission
  reason?: string
}

const normalize = (p: string): string => {
  const normalized = p.split(path.sep).join('/')
  return normalized.replace(/^\.?\/*/, '')
}

export const buildPathPermissions = (config: CanopyConfig): PathPermission[] =>
  config.pathPermissions ?? []

const matchesRule = (rule: PathPermission, relativePath: string): boolean =>
  minimatch(relativePath, rule.path, { dot: true })

const isAllowedByRule = (
  rule: PathPermission,
  userId: CanopyUserId,
  groupIds: string[] | undefined,
  role?: Role,
): boolean => {
  if (rule.managerOrAdminAllowed) {
    return role === 'admin' || role === 'manager'
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
 * Default allow if no rule matches. First matching rule wins.
 */
export const checkPathAccess = ({
  rules,
  relativePath,
  userId,
  groupIds,
  role,
}: {
  rules: PathPermission[]
  relativePath: string
  userId: CanopyUserId
  groupIds?: string[]
  role?: Role
}): PathPermissionResult => {
  const normalizedPath = normalize(relativePath)
  const privileged = role === 'admin' || role === 'manager'
  if (privileged) {
    return { allowed: true, reason: 'admin_or_manager' }
  }

  for (const rule of rules) {
    if (!matchesRule(rule, normalizedPath)) {
      continue
    }
    const allowed = isAllowedByRule(rule, userId, groupIds, role)
    return {
      allowed,
      matchedRule: rule,
      reason: allowed ? 'allowed_by_rule' : 'denied_by_rule',
    }
  }

  return { allowed: true, reason: 'no_rule_match' }
}

/**
 * Factory to bind rules once.
 */
export const createCheckPathAccess = (rules: PathPermission[]) => {
  return (input: Omit<Parameters<typeof checkPathAccess>[0], 'rules'>): PathPermissionResult =>
    checkPathAccess({ ...input, rules })
}
