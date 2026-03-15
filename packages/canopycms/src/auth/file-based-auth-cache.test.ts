import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { FileBasedAuthCache, writeAuthCacheSnapshot } from './file-based-auth-cache'

describe('FileBasedAuthCache', () => {
  let tmpDir: string
  let cache: FileBasedAuthCache

  const testUsers = {
    users: [
      { id: 'user_1', name: 'Alice', email: 'alice@test.com', avatarUrl: 'https://avatar/alice' },
      { id: 'user_2', name: 'Bob', email: 'bob@test.com' },
    ],
  }

  const testGroups = {
    groups: [
      { id: 'org_1', name: 'Engineering', memberCount: 5 },
      { id: 'org_2', name: 'Design', memberCount: 3 },
    ],
  }

  const testMemberships = {
    memberships: {
      user_1: ['org_1', 'org_2'],
      user_2: ['org_1'],
    },
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-cache-test-'))
    cache = new FileBasedAuthCache(tmpDir)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function writeCache() {
    await fs.writeFile(path.join(tmpDir, 'users.json'), JSON.stringify(testUsers))
    await fs.writeFile(path.join(tmpDir, 'orgs.json'), JSON.stringify(testGroups))
    await fs.writeFile(path.join(tmpDir, 'memberships.json'), JSON.stringify(testMemberships))
  }

  describe('with populated cache', () => {
    beforeEach(writeCache)

    it('getUser returns user by ID', async () => {
      const user = await cache.getUser('user_1')
      expect(user).toEqual(testUsers.users[0])
    })

    it('getUser returns null for unknown ID', async () => {
      const user = await cache.getUser('unknown')
      expect(user).toBeNull()
    })

    it('getGroup returns group by ID', async () => {
      const group = await cache.getGroup('org_1')
      expect(group).toEqual(testGroups.groups[0])
    })

    it('getGroup returns null for unknown ID', async () => {
      const group = await cache.getGroup('unknown')
      expect(group).toBeNull()
    })

    it('getAllUsers returns all users', async () => {
      const users = await cache.getAllUsers()
      expect(users).toHaveLength(2)
      expect(users[0].name).toBe('Alice')
    })

    it('getAllGroups returns all groups', async () => {
      const groups = await cache.getAllGroups()
      expect(groups).toHaveLength(2)
    })

    it('getUserExternalGroups returns group IDs for user', async () => {
      const groups = await cache.getUserExternalGroups('user_1')
      expect(groups).toEqual(['org_1', 'org_2'])
    })

    it('getUserExternalGroups returns empty array for unknown user', async () => {
      const groups = await cache.getUserExternalGroups('unknown')
      expect(groups).toEqual([])
    })
  })

  describe('with empty cache directory', () => {
    it('returns empty results when no cache files exist', async () => {
      const users = await cache.getAllUsers()
      expect(users).toEqual([])

      const groups = await cache.getAllGroups()
      expect(groups).toEqual([])

      const user = await cache.getUser('user_1')
      expect(user).toBeNull()
    })
  })

  describe('cache invalidation', () => {
    it('re-reads cache when file mtime changes', async () => {
      await writeCache()

      // First read
      const users1 = await cache.getAllUsers()
      expect(users1).toHaveLength(2)

      // Wait a moment so mtime changes
      await new Promise((r) => setTimeout(r, 50))

      // Update cache with different data
      const updatedUsers = {
        users: [{ id: 'user_3', name: 'Charlie', email: 'charlie@test.com' }],
      }
      await fs.writeFile(path.join(tmpDir, 'users.json'), JSON.stringify(updatedUsers))

      // Should pick up new data
      const users2 = await cache.getAllUsers()
      expect(users2).toHaveLength(1)
      expect(users2[0].name).toBe('Charlie')
    })

    it('uses cached data when mtime unchanged', async () => {
      await writeCache()

      // Read twice — should use in-memory cache on second read
      const users1 = await cache.getAllUsers()
      const users2 = await cache.getAllUsers()
      expect(users1).toEqual(users2)
    })
  })

  describe('partial cache files', () => {
    it('handles missing orgs.json gracefully', async () => {
      await fs.writeFile(path.join(tmpDir, 'users.json'), JSON.stringify(testUsers))
      // No orgs.json or memberships.json

      const users = await cache.getAllUsers()
      expect(users).toHaveLength(2)

      const groups = await cache.getAllGroups()
      expect(groups).toEqual([])
    })

    it('handles malformed JSON gracefully', async () => {
      await fs.writeFile(path.join(tmpDir, 'users.json'), 'not json')

      const users = await cache.getAllUsers()
      expect(users).toEqual([])
    })
  })

  describe('snapshot layout (symlink)', () => {
    it('reads from snapshot directory via current symlink', async () => {
      await writeAuthCacheSnapshot(tmpDir, {
        'users.json': testUsers,
        'orgs.json': testGroups,
        'memberships.json': testMemberships,
      })

      const snapshotCache = new FileBasedAuthCache(tmpDir)
      const users = await snapshotCache.getAllUsers()
      expect(users).toHaveLength(2)
      expect(users[0].name).toBe('Alice')

      const groups = await snapshotCache.getAllGroups()
      expect(groups).toHaveLength(2)

      const memberships = await snapshotCache.getUserExternalGroups('user_1')
      expect(memberships).toEqual(['org_1', 'org_2'])
    })

    it('picks up new snapshot after symlink swap', async () => {
      await writeAuthCacheSnapshot(tmpDir, {
        'users.json': testUsers,
        'orgs.json': testGroups,
        'memberships.json': testMemberships,
      })

      const snapshotCache = new FileBasedAuthCache(tmpDir)
      const users1 = await snapshotCache.getAllUsers()
      expect(users1).toHaveLength(2)

      // Wait so mtime changes
      await new Promise((r) => setTimeout(r, 50))

      // Write new snapshot with different data
      const updatedUsers = {
        users: [{ id: 'user_3', name: 'Charlie', email: 'charlie@test.com' }],
      }
      await writeAuthCacheSnapshot(tmpDir, {
        'users.json': updatedUsers,
        'orgs.json': { groups: [] },
        'memberships.json': { memberships: {} },
      })

      const users2 = await snapshotCache.getAllUsers()
      expect(users2).toHaveLength(1)
      expect(users2[0].name).toBe('Charlie')
    })

    it('cleans up old snapshots keeping only 2', async () => {
      // Write 3 snapshots
      await writeAuthCacheSnapshot(tmpDir, {
        'users.json': { users: [] },
        'orgs.json': { groups: [] },
        'memberships.json': { memberships: {} },
      })
      await new Promise((r) => setTimeout(r, 10))
      await writeAuthCacheSnapshot(tmpDir, {
        'users.json': { users: [] },
        'orgs.json': { groups: [] },
        'memberships.json': { memberships: {} },
      })
      await new Promise((r) => setTimeout(r, 10))
      await writeAuthCacheSnapshot(tmpDir, {
        'users.json': { users: [] },
        'orgs.json': { groups: [] },
        'memberships.json': { memberships: {} },
      })

      const entries = await fs.readdir(tmpDir)
      const snapshots = entries.filter((e) => e.startsWith('snapshot-'))
      expect(snapshots).toHaveLength(2)
    })
  })
})
