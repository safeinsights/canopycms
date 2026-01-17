/**
 * Path-level authorization
 *
 * Handles checking if a user can access a specific path based on permission rules.
 */

import path from 'node:path'

import { minimatch } from 'minimatch'

import type { PathPermission, DefaultPathAccess, PermissionLevel, PermissionTarget } from '../config'
import { isAdmin } from './helpers'
import type { CanopyUser } from '../user'
import type { PathPermissionResult } from './types'

/**
 * Normalize a path for consistent matching
 */
function normalize(p: string): string {
  const normalized = p.split(path.sep).join('/')
  return normalized.replace(/^\.?\/*/, '')
}

/**
 * Check if a path matches a permission rule
 */
function matchesRule(rule: PathPermission, relativePath: string): boolean {
  return minimatch(relativePath, rule.path, { dot: true })
}

/**
 * Check if user matches a permission target
 */
function isAllowedByTarget(target: PermissionTarget, user: CanopyUser): boolean {
  const hasUserConstraint = !!target.allowedUsers?.length
  const hasGroupConstraint = !!target.allowedGroups?.length

  // No constraints means allowed (rule applies to everyone)
  if (!hasUserConstraint && !hasGroupConstraint) {
    return true
  }

  const matchesUser = hasUserConstraint && target.allowedUsers?.includes(user.userId)
  const matchesGroup =
    hasGroupConstraint && user.groups?.some((gid) => target.allowedGroups?.includes(gid))

  return Boolean(matchesUser || matchesGroup)
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
  relativePath: string
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

    // Get the permission target for this level
    const target = rule[level]
    if (!target) {
      // No permissions defined for this level on this rule, continue to next rule
      continue
    }

    const allowed = isAllowedByTarget(target, user)
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
export function createCheckPathAccess(rules: PathPermission[], defaultAccess: DefaultPathAccess) {
  return (input: {
    relativePath: string
    user: CanopyUser
    level: PermissionLevel
  }): PathPermissionResult => checkPathAccess({ ...input, rules, defaultAccess })
}
