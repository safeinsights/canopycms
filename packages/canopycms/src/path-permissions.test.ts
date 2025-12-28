import { describe, expect, it } from 'vitest'

import { checkPathAccess } from './path-permissions'
import { RESERVED_GROUPS } from './reserved-groups'
import type { PathPermission } from './config'

// Path permission rules (previously from config.pathPermissions, now from .canopycms/permissions.json)
const rules: PathPermission[] = [
  { path: 'content/admin/**', managerOrAdminAllowed: true },
  { path: 'content/partners/**', allowedGroups: ['partner-org'] },
  { path: 'content/restricted/**', allowedUsers: ['user-a'] },
]

describe('path permissions', () => {
  it('allows admin', () => {
    const result = checkPathAccess({
      rules,
      relativePath: 'content/admin/secret.md',
      userId: 'any',
      groupIds: [RESERVED_GROUPS.ADMINS],
    })
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('admin')
  })

  it('allows reviewer for managerOrAdminAllowed paths', () => {
    const result = checkPathAccess({
      rules,
      relativePath: 'content/admin/secret.md',
      userId: 'any',
      groupIds: [RESERVED_GROUPS.REVIEWERS],
    })
    expect(result.allowed).toBe(true)
  })

  it('denies managerOrAdminAllowed for regular users without matching allowlists', () => {
    const result = checkPathAccess({
      rules,
      relativePath: 'content/admin/secret.md',
      userId: 'user-a',
      groupIds: ['partner-org'],
    })
    expect(result.allowed).toBe(false)
  })

  it('allows group membership', () => {
    const result = checkPathAccess({
      rules,
      relativePath: 'content/partners/page.md',
      userId: 'user-x',
      groupIds: ['partner-org'],
    })
    expect(result.allowed).toBe(true)
  })

  it('denies missing group membership', () => {
    const result = checkPathAccess({
      rules,
      relativePath: 'content/partners/page.md',
      userId: 'user-x',
      groupIds: ['other-org'],
    })
    expect(result.allowed).toBe(false)
  })

  it('defaults to allow when no rule matches', () => {
    const result = checkPathAccess({
      rules,
      relativePath: 'content/open/page.md',
      userId: 'user-x',
    })
    expect(result.allowed).toBe(true)
  })

  it('uses defaultAccess=allow when no rule matches and explicitly set', () => {
    const result = checkPathAccess({
      rules,
      relativePath: 'content/open/page.md',
      userId: 'user-x',
      defaultAccess: 'allow',
    })
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('no_rule_match')
  })

  it('uses defaultAccess=deny when no rule matches', () => {
    const result = checkPathAccess({
      rules,
      relativePath: 'content/open/page.md',
      userId: 'user-x',
      defaultAccess: 'deny',
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('no_rule_match')
  })

  it('applies matching rule regardless of defaultAccess', () => {
    // Even with defaultAccess=allow, a matching rule that denies should deny
    const result = checkPathAccess({
      rules,
      relativePath: 'content/admin/secret.md',
      userId: 'regular-user',
      groupIds: [],
      defaultAccess: 'allow',
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('denied_by_rule')
  })
})
