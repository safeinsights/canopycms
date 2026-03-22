import { describe, expect, it } from 'vitest'

import { checkPathAccess, RESERVED_GROUPS } from '../'
import { unsafeAsPermissionPath } from '../test-utils'
import type { PathPermission } from '../../config'
import type { CanopyUser } from '../../user'
import { unsafeAsPhysicalPath } from '../../paths/test-utils'

// Path permission rules (previously from config.pathPermissions, now from .canopycms/permissions.json)
const rules: PathPermission[] = [
  { path: unsafeAsPermissionPath('content/admin/**'), edit: {} },
  {
    path: unsafeAsPermissionPath('content/partners/**'),
    edit: { allowedGroups: ['partner-org'] },
  },
  {
    path: unsafeAsPermissionPath('content/restricted/**'),
    edit: { allowedUsers: ['user-a'] },
  },
]

// Helper to create authenticated users
const createUser = (userId: string, groups: string[] = []): CanopyUser => ({
  type: 'authenticated',
  userId,
  groups,
})

describe('path permissions', () => {
  it('allows admin', () => {
    const result = checkPathAccess({
      rules,
      relativePath: unsafeAsPhysicalPath('content/admin/secret.md'),
      user: createUser('any', [RESERVED_GROUPS.ADMINS]),
      defaultAccess: 'deny',
      level: 'edit',
    })
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('admin')
  })

  it('allows user when edit rule has no constraints', () => {
    const result = checkPathAccess({
      rules,
      relativePath: unsafeAsPhysicalPath('content/admin/secret.md'),
      user: createUser('any', []),
      defaultAccess: 'deny',
      level: 'edit',
    })
    expect(result.allowed).toBe(true)
  })

  it('denies when user does not match allowedUsers or allowedGroups', () => {
    const result = checkPathAccess({
      rules,
      relativePath: unsafeAsPhysicalPath('content/restricted/secret.md'),
      user: createUser('user-b', ['partner-org']),
      defaultAccess: 'deny',
      level: 'edit',
    })
    expect(result.allowed).toBe(false)
  })

  it('allows group membership', () => {
    const result = checkPathAccess({
      rules,
      relativePath: unsafeAsPhysicalPath('content/partners/page.md'),
      user: createUser('user-x', ['partner-org']),
      defaultAccess: 'deny',
      level: 'edit',
    })
    expect(result.allowed).toBe(true)
  })

  it('denies missing group membership', () => {
    const result = checkPathAccess({
      rules,
      relativePath: unsafeAsPhysicalPath('content/partners/page.md'),
      user: createUser('user-x', ['other-org']),
      defaultAccess: 'deny',
      level: 'edit',
    })
    expect(result.allowed).toBe(false)
  })

  it('defaults to allow when no rule matches', () => {
    const result = checkPathAccess({
      rules,
      relativePath: unsafeAsPhysicalPath('content/open/page.md'),
      user: createUser('user-x'),
      defaultAccess: 'allow',
      level: 'edit',
    })
    expect(result.allowed).toBe(true)
  })

  it('uses defaultAccess=allow when no rule matches and explicitly set', () => {
    const result = checkPathAccess({
      rules,
      relativePath: unsafeAsPhysicalPath('content/open/page.md'),
      user: createUser('user-x'),
      defaultAccess: 'allow',
      level: 'edit',
    })
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('no_rule_match')
  })

  it('uses defaultAccess=deny when no rule matches', () => {
    const result = checkPathAccess({
      rules,
      relativePath: unsafeAsPhysicalPath('content/open/page.md'),
      user: createUser('user-x'),
      defaultAccess: 'deny',
      level: 'edit',
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('no_rule_match')
  })

  it('applies matching rule regardless of defaultAccess', () => {
    // Even with defaultAccess=allow, a matching rule that denies should deny
    const result = checkPathAccess({
      rules,
      relativePath: unsafeAsPhysicalPath('content/restricted/secret.md'),
      user: createUser('regular-user', []),
      defaultAccess: 'allow',
      level: 'edit',
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('denied_by_rule')
  })
})
