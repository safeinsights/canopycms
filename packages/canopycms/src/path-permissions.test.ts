import { describe, expect, it } from 'vitest'

import { defineCanopyTestConfig } from './config-test'
import { buildPathPermissions, checkPathAccess } from './path-permissions'
import { RESERVED_GROUPS } from './reserved-groups'

const config = defineCanopyTestConfig({
  schema: [
    {
      type: 'collection',
      name: 'posts',
      path: 'posts',
      format: 'md',
      fields: [{ name: 'title', type: 'string' }],
    },
  ],
  pathPermissions: [
    { path: 'content/admin/**', managerOrAdminAllowed: true },
    { path: 'content/partners/**', allowedGroups: ['partner-org'] },
    { path: 'content/restricted/**', allowedUsers: ['user-a'] },
  ],
})

const rules = buildPathPermissions(config)

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
})
