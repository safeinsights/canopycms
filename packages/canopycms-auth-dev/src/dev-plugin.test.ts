import { describe, it, expect } from 'vitest'
import { DevAuthPlugin, createDevAuthPlugin, DEFAULT_USERS, DEFAULT_GROUPS } from './dev-plugin'
import type { DevUser, DevGroup } from './dev-plugin'
import type { AuthenticationResult } from 'canopycms/auth'

// Type guard to assert successful authentication
function assertSuccess(
  result: AuthenticationResult,
): asserts result is AuthenticationResult & {
  success: true
  user: NonNullable<AuthenticationResult['user']>
} {
  expect(result.success).toBe(true)
  if (!result.success || !result.user) {
    throw new Error('Authentication failed')
  }
}

describe('DevAuthPlugin', () => {
  describe('authenticate', () => {
    it('returns default user when no headers provided', async () => {
      const plugin = new DevAuthPlugin({})
      const result = await plugin.authenticate(new Headers())

      assertSuccess(result)
      expect(result.user.userId).toBe('devuser_2nK8mP4xL9') // user1
      expect(result.user.name).toBe('User One')
      expect(result.user.email).toBe('user1@localhost.dev')
      expect(result.user.externalGroups).toEqual(['team-a', 'team-b'])
    })

    it('authenticates via X-Test-User header', async () => {
      const plugin = new DevAuthPlugin({})
      const headers = new Headers({ 'X-Test-User': 'admin' })
      const result = await plugin.authenticate(headers)

      assertSuccess(result)
      expect(result.user.userId).toBe('devuser_3xY6zW1qR5') // admin1
      expect(result.user.name).toBe('Admin One')
    })

    it('authenticates via x-dev-user-id header', async () => {
      const plugin = new DevAuthPlugin({})
      const headers = new Headers({ 'x-dev-user-id': 'devuser_7qR3tY6wN2' })
      const result = await plugin.authenticate(headers)

      assertSuccess(result)
      expect(result.user.userId).toBe('devuser_7qR3tY6wN2') // user2
      expect(result.user.name).toBe('User Two')
    })

    it('authenticates via canopy-dev-user cookie', async () => {
      const plugin = new DevAuthPlugin({})
      const headers = new Headers({
        cookie: 'canopy-dev-user=devuser_5vS1pM8kJ4; other=value',
      })
      const result = await plugin.authenticate(headers)

      assertSuccess(result)
      expect(result.user.userId).toBe('devuser_5vS1pM8kJ4') // user3
      expect(result.user.name).toBe('User Three')
    })

    it('prioritizes X-Test-User over cookie', async () => {
      const plugin = new DevAuthPlugin({})
      const headers = new Headers({
        'X-Test-User': 'admin',
        cookie: 'canopy-dev-user=devuser_2nK8mP4xL9',
      })
      const result = await plugin.authenticate(headers)

      assertSuccess(result)
      expect(result.user.userId).toBe('devuser_3xY6zW1qR5') // admin1 from header
    })

    it('maps test user keys to dev user IDs', async () => {
      const plugin = new DevAuthPlugin({})

      const testCases = [
        { key: 'admin', expectedId: 'devuser_3xY6zW1qR5' },
        { key: 'editor', expectedId: 'devuser_2nK8mP4xL9' },
        { key: 'viewer', expectedId: 'devuser_7qR3tY6wN2' },
        { key: 'reviewer', expectedId: 'devuser_9aB4cD2eF7' },
      ]

      for (const { key, expectedId } of testCases) {
        const headers = new Headers({ 'X-Test-User': key })
        const result = await plugin.authenticate(headers)

        assertSuccess(result)
        expect(result.user.userId).toBe(expectedId)
      }
    })

    it('returns failure for unknown user ID', async () => {
      const plugin = new DevAuthPlugin({})
      const headers = new Headers({ 'x-dev-user-id': 'unknown_user' })
      const result = await plugin.authenticate(headers)

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('Dev user not found')
      }
    })

    it('uses custom default user when specified', async () => {
      const plugin = new DevAuthPlugin({
        defaultUserId: 'devuser_3xY6zW1qR5', // admin1
      })
      const result = await plugin.authenticate(new Headers())

      assertSuccess(result)
      expect(result.user.userId).toBe('devuser_3xY6zW1qR5')
    })
  })

  describe('searchUsers', () => {
    it('returns all users when query is empty', async () => {
      const plugin = new DevAuthPlugin({})
      const results = await plugin.searchUsers('')

      expect(results).toHaveLength(5)
      expect(results[0].id).toBe('devuser_2nK8mP4xL9')
      expect(results[0].name).toBe('User One')
      expect(results[0].email).toBe('user1@localhost.dev')
    })

    it('filters users by name', async () => {
      const plugin = new DevAuthPlugin({})
      const results = await plugin.searchUsers('admin')

      expect(results).toHaveLength(1)
      expect(results[0].name).toBe('Admin One')
    })

    it('filters users by email', async () => {
      const plugin = new DevAuthPlugin({})
      const results = await plugin.searchUsers('reviewer1@')

      expect(results).toHaveLength(1)
      expect(results[0].id).toBe('devuser_9aB4cD2eF7')
    })

    it('is case insensitive', async () => {
      const plugin = new DevAuthPlugin({})
      const results = await plugin.searchUsers('USER')

      expect(results.length).toBeGreaterThan(0)
      expect(results.some((u) => u.name.toLowerCase().includes('user'))).toBe(true)
    })

    it('respects limit parameter', async () => {
      const plugin = new DevAuthPlugin({})
      const results = await plugin.searchUsers('', 2)

      expect(results).toHaveLength(2)
    })

    it('works with custom users', async () => {
      const customUsers: DevUser[] = [
        {
          userId: 'custom_1',
          name: 'Custom User',
          email: 'custom@test.com',
          externalGroups: [],
        },
      ]
      const plugin = new DevAuthPlugin({ users: customUsers })
      const results = await plugin.searchUsers('custom')

      expect(results).toHaveLength(1)
      expect(results[0].id).toBe('custom_1')
    })
  })

  describe('getUserMetadata', () => {
    it('returns user metadata for valid user', async () => {
      const plugin = new DevAuthPlugin({})
      const metadata = await plugin.getUserMetadata('devuser_2nK8mP4xL9')

      expect(metadata).toEqual({
        id: 'devuser_2nK8mP4xL9',
        name: 'User One',
        email: 'user1@localhost.dev',
        avatarUrl: undefined,
      })
    })

    it('returns null for unknown user', async () => {
      const plugin = new DevAuthPlugin({})
      const metadata = await plugin.getUserMetadata('unknown')

      expect(metadata).toBeNull()
    })

    it('includes avatarUrl when present', async () => {
      const customUsers: DevUser[] = [
        {
          userId: 'user_1',
          name: 'User',
          email: 'user@test.com',
          avatarUrl: 'https://example.com/avatar.jpg',
          externalGroups: [],
        },
      ]
      const plugin = new DevAuthPlugin({ users: customUsers })
      const metadata = await plugin.getUserMetadata('user_1')

      expect(metadata?.avatarUrl).toBe('https://example.com/avatar.jpg')
    })
  })

  describe('getGroupMetadata', () => {
    it('returns group metadata for valid group', async () => {
      const plugin = new DevAuthPlugin({})
      const metadata = await plugin.getGroupMetadata('team-a')

      expect(metadata).toEqual({
        id: 'team-a',
        name: 'Team A',
        description: 'Team A',
      })
    })

    it('returns null for unknown group', async () => {
      const plugin = new DevAuthPlugin({})
      const metadata = await plugin.getGroupMetadata('unknown')

      expect(metadata).toBeNull()
    })

    it('works with custom groups', async () => {
      const customGroups: DevGroup[] = [
        { id: 'team-x', name: 'Team X', description: 'Custom team' },
      ]
      const plugin = new DevAuthPlugin({ groups: customGroups })
      const metadata = await plugin.getGroupMetadata('team-x')

      expect(metadata).toEqual({
        id: 'team-x',
        name: 'Team X',
        description: 'Custom team',
      })
    })
  })

  describe('listGroups', () => {
    it('returns all groups by default', async () => {
      const plugin = new DevAuthPlugin({})
      const groups = await plugin.listGroups()

      expect(groups).toHaveLength(3)
      expect(groups.map((g) => g.id)).toEqual(['team-a', 'team-b', 'team-c'])
    })

    it('respects limit parameter', async () => {
      const plugin = new DevAuthPlugin({})
      const groups = await plugin.listGroups(2)

      expect(groups).toHaveLength(2)
    })
  })

  describe('searchExternalGroups', () => {
    it('returns all groups when query is empty', async () => {
      const plugin = new DevAuthPlugin({})
      const results = await plugin.searchExternalGroups('')

      expect(results).toHaveLength(3)
    })

    it('filters groups by name', async () => {
      const plugin = new DevAuthPlugin({})
      const results = await plugin.searchExternalGroups('team a')

      expect(results).toHaveLength(1)
      expect(results[0].id).toBe('team-a')
      expect(results[0].name).toBe('Team A')
    })

    it('is case insensitive', async () => {
      const plugin = new DevAuthPlugin({})
      const results = await plugin.searchExternalGroups('TEAM')

      expect(results.length).toBeGreaterThan(0)
    })
  })

  describe('custom configuration', () => {
    it('accepts custom users and groups', () => {
      const customUsers: DevUser[] = [
        {
          userId: 'custom_1',
          name: 'Custom',
          email: 'custom@test.com',
          externalGroups: ['custom-group'],
        },
      ]
      const customGroups: DevGroup[] = [{ id: 'custom-group', name: 'Custom Group' }]

      const plugin = new DevAuthPlugin({
        users: customUsers,
        groups: customGroups,
        defaultUserId: 'custom_1',
      })

      expect(plugin).toBeInstanceOf(DevAuthPlugin)
    })
  })

  describe('createDevAuthPlugin factory', () => {
    it('creates plugin with default config', () => {
      const plugin = createDevAuthPlugin()
      expect(plugin).toBeInstanceOf(DevAuthPlugin)
    })

    it('creates plugin with custom config', () => {
      const plugin = createDevAuthPlugin({
        defaultUserId: 'devuser_3xY6zW1qR5',
      })
      expect(plugin).toBeInstanceOf(DevAuthPlugin)
    })

    it('works without any arguments', () => {
      const plugin = createDevAuthPlugin()
      expect(plugin).toBeInstanceOf(DevAuthPlugin)
    })
  })

  describe('DEFAULT_USERS', () => {
    it('exports default users', () => {
      expect(DEFAULT_USERS).toHaveLength(5)
      expect(DEFAULT_USERS[0].userId).toBe('devuser_2nK8mP4xL9')
      expect(DEFAULT_USERS[4].userId).toBe('devuser_3xY6zW1qR5')
    })

    it('has correct user structure', () => {
      DEFAULT_USERS.forEach((user) => {
        expect(user).toHaveProperty('userId')
        expect(user).toHaveProperty('name')
        expect(user).toHaveProperty('email')
        expect(user).toHaveProperty('externalGroups')
        expect(Array.isArray(user.externalGroups)).toBe(true)
      })
    })
  })

  describe('DEFAULT_GROUPS', () => {
    it('exports default groups', () => {
      expect(DEFAULT_GROUPS).toHaveLength(3)
      expect(DEFAULT_GROUPS.map((g) => g.id)).toEqual(['team-a', 'team-b', 'team-c'])
    })

    it('has correct group structure', () => {
      DEFAULT_GROUPS.forEach((group) => {
        expect(group).toHaveProperty('id')
        expect(group).toHaveProperty('name')
        expect(group).toHaveProperty('description')
      })
    })
  })

  describe('cookie parsing', () => {
    it('extracts cookie from single cookie string', async () => {
      const plugin = new DevAuthPlugin({})
      const headers = new Headers({
        cookie: 'canopy-dev-user=devuser_3xY6zW1qR5',
      })
      const result = await plugin.authenticate(headers)

      assertSuccess(result)
      expect(result.user.userId).toBe('devuser_3xY6zW1qR5')
    })

    it('extracts cookie from multiple cookies', async () => {
      const plugin = new DevAuthPlugin({})
      const headers = new Headers({
        cookie: 'session=abc123; canopy-dev-user=devuser_7qR3tY6wN2; other=value',
      })
      const result = await plugin.authenticate(headers)

      assertSuccess(result)
      expect(result.user.userId).toBe('devuser_7qR3tY6wN2')
    })

    it('extracts cookie without semicolon separator', async () => {
      const plugin = new DevAuthPlugin({})
      const headers = new Headers({
        cookie: 'canopy-dev-user=devuser_9aB4cD2eF7',
      })
      const result = await plugin.authenticate(headers)

      assertSuccess(result)
      expect(result.user.userId).toBe('devuser_9aB4cD2eF7')
    })

    it('returns default user when cookie not found', async () => {
      const plugin = new DevAuthPlugin({})
      const headers = new Headers({
        cookie: 'session=abc123; other=value',
      })
      const result = await plugin.authenticate(headers)

      assertSuccess(result)
      expect(result.user.userId).toBe('devuser_2nK8mP4xL9') // default
    })
  })
})
