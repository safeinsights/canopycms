import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { loadPathPermissions, savePathPermissions, ensurePermissionsFile } from '../permissions'
import { unsafeAsPermissionPath } from '../test-utils'
import { mockConsole } from '../../test-utils/console-spy.js'

describe('permissions loader', () => {
  let testRoot: string

  beforeEach(async () => {
    testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-perms-test-'))
  })

  afterEach(async () => {
    await fs.rm(testRoot, { recursive: true, force: true })
  })

  describe('loadPathPermissions', () => {
    it('loads from file when it exists', async () => {
      // Create permissions file
      const canopyDir = testRoot
      await fs.mkdir(canopyDir, { recursive: true })
      await fs.writeFile(
        path.join(canopyDir, 'permissions.json'),
        JSON.stringify({
          version: 1,
          updatedAt: new Date().toISOString(),
          updatedBy: 'admin-user',
          pathPermissions: [
            {
              path: 'content/admin/**',
              edit: {},
            },
            {
              path: 'content/partners/**',
              edit: { allowedGroups: ['partner-org'] },
            },
          ],
        }),
        'utf-8'
      )

      const permissions = await loadPathPermissions(testRoot, 'prod')

      expect(permissions).toHaveLength(2)
      expect(permissions[0]).toEqual({
        path: 'content/admin/**',
        edit: {},
      })
      expect(permissions[1]).toEqual({
        path: 'content/partners/**',
        edit: { allowedGroups: ['partner-org'] },
      })
    })

    it('returns empty array when file does not exist', async () => {
      const permissions = await loadPathPermissions(testRoot, 'prod')
      expect(permissions).toEqual([])
    })

    it('throws error on invalid JSON', async () => {
      const consoleSpy = mockConsole()

      // Create invalid permissions file in new location
      const canopyDir = testRoot
      await fs.mkdir(canopyDir, { recursive: true })
      await fs.writeFile(path.join(canopyDir, 'permissions.json'), 'invalid json', 'utf-8')

      await expect(loadPathPermissions(testRoot, 'prod')).rejects.toThrow('Invalid permissions file')
      expect(consoleSpy).toHaveErrored('Failed to parse permissions file')
      consoleSpy.restore()
    })

    it('throws error on invalid schema', async () => {
      const consoleSpy = mockConsole()

      // Create file with wrong version in new location
      const canopyDir = testRoot
      await fs.mkdir(canopyDir, { recursive: true })
      await fs.writeFile(
        path.join(canopyDir, 'permissions.json'),
        JSON.stringify({
          version: 2, // Wrong version
          updatedAt: new Date().toISOString(),
          updatedBy: 'admin',
          pathPermissions: [],
        }),
        'utf-8'
      )

      await expect(loadPathPermissions(testRoot, 'prod')).rejects.toThrow('Invalid permissions file')
      expect(consoleSpy).toHaveErrored('Failed to parse permissions file')
      consoleSpy.restore()
    })
  })

  describe('savePathPermissions', () => {
    it('saves permissions to file', async () => {
      const permissions = [
        {
          path: unsafeAsPermissionPath('content/admin/**'),
          edit: {},
        },
        {
          path: unsafeAsPermissionPath('content/users/**'),
          edit: { allowedUsers: ['user-1', 'user-2'] },
        },
      ]

      await savePathPermissions(testRoot, permissions, 'admin-user', 'prod')

      const filePath = path.join(testRoot, 'permissions.json')
      const fileContent = await fs.readFile(filePath, 'utf-8')
      const parsed = JSON.parse(fileContent)

      expect(parsed.version).toBe(1)
      expect(parsed.updatedBy).toBe('admin-user')
      expect(parsed.updatedAt).toBeTruthy()
      expect(parsed.pathPermissions).toHaveLength(2)
      expect(parsed.pathPermissions[0]).toEqual({
        path: 'content/admin/**',
        edit: {},
      })
    })

    it('validates permissions before saving', async () => {
      const invalidPermissions: any = [
        {
          path: '', // Invalid empty path
          edit: {},
        },
      ]

      await expect(savePathPermissions(testRoot, invalidPermissions, 'admin', 'prod')).rejects.toThrow()
    })

    it('overwrites existing file', async () => {
      const firstPermissions = [{ path: unsafeAsPermissionPath('content/first/**'), edit: { allowedUsers: ['user-1'] } }]
      await savePathPermissions(testRoot, firstPermissions, 'admin-1', 'prod')

      const secondPermissions = [{ path: unsafeAsPermissionPath('content/second/**'), edit: { allowedUsers: ['user-2'] } }]
      await savePathPermissions(testRoot, secondPermissions, 'admin-2', 'prod')

      const loaded = await loadPathPermissions(testRoot, 'prod')

      expect(loaded).toHaveLength(1)
      expect(loaded[0].path).toBe('content/second/**')
    })
  })

  describe('ensurePermissionsFile', () => {
    it('creates default file if it does not exist', async () => {
      await ensurePermissionsFile(testRoot, 'admin-user', 'prod')

      const filePath = path.join(testRoot, 'permissions.json')
      const fileContent = await fs.readFile(filePath, 'utf-8')
      const parsed = JSON.parse(fileContent)

      expect(parsed.version).toBe(1)
      expect(parsed.updatedBy).toBe('admin-user')
      expect(parsed.pathPermissions).toEqual([])
    })

    it('does nothing if file already exists', async () => {
      const existingPermissions = [{ path: unsafeAsPermissionPath('content/**'), edit: { allowedUsers: ['existing'] } }]
      await savePathPermissions(testRoot, existingPermissions, 'original-admin', 'prod')

      await ensurePermissionsFile(testRoot, 'new-admin', 'prod')

      const loaded = await loadPathPermissions(testRoot, 'prod')

      // Original permissions should still be there
      expect(loaded).toHaveLength(1)
      expect(loaded[0].path).toBe('content/**')
    })
  })
})
