import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { loadPathPermissions, savePathPermissions, ensurePermissionsFile } from './permissions-loader'
import { mockConsole } from './test-utils/console-spy.js'

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
      const canopyDir = path.join(testRoot, '.canopycms')
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
              managerOrAdminAllowed: true,
            },
            {
              path: 'content/partners/**',
              allowedGroups: ['partner-org'],
            },
          ],
        }),
        'utf-8'
      )

      const permissions = await loadPathPermissions(testRoot)

      expect(permissions).toHaveLength(2)
      expect(permissions[0]).toEqual({
        path: 'content/admin/**',
        managerOrAdminAllowed: true,
      })
      expect(permissions[1]).toEqual({
        path: 'content/partners/**',
        allowedGroups: ['partner-org'],
      })
    })

    it('returns empty array when file does not exist', async () => {
      const permissions = await loadPathPermissions(testRoot)
      expect(permissions).toEqual([])
    })

    it('throws error on invalid JSON', async () => {
      const consoleSpy = mockConsole()

      // Create invalid permissions file
      const canopyDir = path.join(testRoot, '.canopycms')
      await fs.mkdir(canopyDir, { recursive: true })
      await fs.writeFile(path.join(canopyDir, 'permissions.json'), 'invalid json', 'utf-8')

      await expect(loadPathPermissions(testRoot)).rejects.toThrow('Invalid permissions file')
      expect(consoleSpy).toHaveErrored('Failed to parse permissions file')
      consoleSpy.restore()
    })

    it('throws error on invalid schema', async () => {
      const consoleSpy = mockConsole()

      // Create file with wrong version
      const canopyDir = path.join(testRoot, '.canopycms')
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

      await expect(loadPathPermissions(testRoot)).rejects.toThrow('Invalid permissions file')
      expect(consoleSpy).toHaveErrored('Failed to parse permissions file')
      consoleSpy.restore()
    })
  })

  describe('savePathPermissions', () => {
    it('saves permissions to file', async () => {
      const permissions = [
        {
          path: 'content/admin/**',
          managerOrAdminAllowed: true,
        },
        {
          path: 'content/users/**',
          allowedUsers: ['user-1', 'user-2'],
        },
      ]

      await savePathPermissions(testRoot, permissions, 'admin-user')

      const filePath = path.join(testRoot, '.canopycms', 'permissions.json')
      const fileContent = await fs.readFile(filePath, 'utf-8')
      const parsed = JSON.parse(fileContent)

      expect(parsed.version).toBe(1)
      expect(parsed.updatedBy).toBe('admin-user')
      expect(parsed.updatedAt).toBeTruthy()
      expect(parsed.pathPermissions).toHaveLength(2)
      expect(parsed.pathPermissions[0]).toEqual({
        path: 'content/admin/**',
        managerOrAdminAllowed: true,
      })
    })

    it('creates .canopycms directory if it does not exist', async () => {
      const permissions = [{ path: 'content/**', allowedGroups: ['all'] }]

      await savePathPermissions(testRoot, permissions, 'user-1')

      const canopyDir = path.join(testRoot, '.canopycms')
      const stats = await fs.stat(canopyDir)
      expect(stats.isDirectory()).toBe(true)
    })

    it('validates permissions before saving', async () => {
      const invalidPermissions: any = [
        {
          path: '', // Invalid empty path
          managerOrAdminAllowed: true,
        },
      ]

      await expect(savePathPermissions(testRoot, invalidPermissions, 'admin')).rejects.toThrow()
    })

    it('overwrites existing file', async () => {
      const firstPermissions = [{ path: 'content/first/**', allowedUsers: ['user-1'] }]
      await savePathPermissions(testRoot, firstPermissions, 'admin-1')

      const secondPermissions = [{ path: 'content/second/**', allowedUsers: ['user-2'] }]
      await savePathPermissions(testRoot, secondPermissions, 'admin-2')

      const loaded = await loadPathPermissions(testRoot)

      expect(loaded).toHaveLength(1)
      expect(loaded[0].path).toBe('content/second/**')
    })
  })

  describe('ensurePermissionsFile', () => {
    it('creates default file if it does not exist', async () => {
      await ensurePermissionsFile(testRoot, 'admin-user')

      const filePath = path.join(testRoot, '.canopycms', 'permissions.json')
      const fileContent = await fs.readFile(filePath, 'utf-8')
      const parsed = JSON.parse(fileContent)

      expect(parsed.version).toBe(1)
      expect(parsed.updatedBy).toBe('admin-user')
      expect(parsed.pathPermissions).toEqual([])
    })

    it('does nothing if file already exists', async () => {
      const existingPermissions = [{ path: 'content/**', allowedUsers: ['existing'] }]
      await savePathPermissions(testRoot, existingPermissions, 'original-admin')

      await ensurePermissionsFile(testRoot, 'new-admin')

      const loaded = await loadPathPermissions(testRoot)

      // Original permissions should still be there
      expect(loaded).toHaveLength(1)
      expect(loaded[0].path).toBe('content/**')
    })
  })
})
